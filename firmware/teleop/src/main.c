/*
 * Teleop bridge: BLE transparent UART (RNBD451, UART3) <-> CANSimple (S1s).
 *
 * Line protocol from the host (GUI/phone), ASCII, newline-terminated:
 *   V,<node>,<mvel>    set velocity, milli-turns/s (e.g. V,0,5000 = 5 t/s)
 *   GO,<node>          velocity mode + closed loop (sensorless spin-up)
 *   STOP,<node>        vel 0 + idle (also cancels a nudge)
 *   N,<node>,<mturns>  nudge: timed move of ~X milli-turns at the sensorless
 *                      floor speed (dead reckoning - no encoder yet)
 *   CLR,<node>         clear errors
 *   PING               replies PONG
 *
 * Upstream to the host, every 500 ms per seen node:
 *   HB,<node>,<state>,<err_hex>,<mvel>
 *
 * Safety: module status message %DISCONNECT% in the BLE stream stops all
 * known nodes immediately.
 *
 * UART is polled with no sleeps (single-byte RX buffer); CAN RX arrives via
 * ISR into a message queue.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/can.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/byteorder.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

static const struct device *const can_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_canbus));
static const struct device *const ble = DEVICE_DT_GET(DT_NODELABEL(uart3));

K_MSGQ_DEFINE(canq, sizeof(struct can_frame), 32, 4);

#define MAX_NODES 6
#define NUDGE_VEL 3.0f     /* turns/s - sensorless floor, minimises coast error */

/* Sensorless spin-up direction comes from config.sensorless_ramp, NOT from
 * the commanded velocity sign - reverse requires flipping the ramp params.
 * Arbitrary-parameter (SDO) endpoint IDs for S1 fw 0.6.11: */
#define EP_SL_RAMP_ACCEL 248
#define EP_SL_RAMP_VEL   249
/* fw 0.6.x units are TURNS/s (a 400 here means 24,000 RPM - learned the loud
 * way). Lock-in target = NUDGE_VEL for a seamless handoff into the cruise. */
#define SL_RAMP_VEL_MAG  3.0f
#define SL_RAMP_ACC_MAG  10.0f

/* commanding vel->0 ramps down over vel^2/(2*ramp_rate) turns; stop early */
#define STOP_LEAD_TURNS 0.45f

struct node_state {
	bool seen;
	uint8_t state;
	uint32_t err;
	float vel;
	float pos;             /* sensorless position estimate, turns */
	float last_cmd_vel;    /* sign decides spin-up direction on GO */
	int8_t ramp_dir;       /* 0 unknown, +/-1 = last written ramp sign */
	bool nudge_run;        /* measured-travel burst in progress */
	float nudge_p0;        /* pos at burst start */
	float nudge_target;    /* signed turns to travel */
	int64_t nudge_deadline;/* safety timeout */
	int64_t nudge_idle_at; /* when to drop to IDLE after ramp-down */
	/* synthetic tracking (for twin without real motors) */
	float cmd_vel;         /* commanded velocity from PyKit (milli-turns/s -> turns/s) */
	float syn_pos;         /* integrated position estimate */
	bool syn_active;       /* true when receiving commands (generates synthetic HB) */
};
static struct node_state nodes[MAX_NODES];
static int64_t last_integrate = 0;  /* for synthetic position integration */

static void can_rx_cb(const struct device *dev, struct can_frame *f, void *ud)
{
	ARG_UNUSED(dev); ARG_UNUSED(ud);
	k_msgq_put(&canq, f, K_NO_WAIT);
}

/* Set to 0 to skip CAN transmit (for testing without motors) */
#define CAN_TX_ENABLED 0

static void can_send8(uint32_t id, const uint8_t *data, uint8_t len)
{
#if CAN_TX_ENABLED
	struct can_frame f = { .id = id, .dlc = can_bytes_to_dlc(len), .flags = 0 };
	memcpy(f.data, data, len);
	/* non-blocking: hardware TX queue is 32 deep, and blocking here loses
	 * UART bytes into the 1-byte receive buffer */
	int r = can_send(can_dev, &f, K_NO_WAIT, NULL, NULL);
	if (r != 0) {
		printk("can_send 0x%03X failed: %d\n", id, r);
	}
#else
	ARG_UNUSED(id);
	ARG_UNUSED(data);
	ARG_UNUSED(len);
	/* CAN TX disabled for testing without motors */
#endif
}

static void set_axis_state(uint8_t node, uint32_t state)
{
	uint8_t d[4];
	sys_put_le32(state, d);
	can_send8((node << 5) | 0x07, d, 4);
}

static void set_controller_mode(uint8_t node, uint32_t control, uint32_t input)
{
	uint8_t d[8];
	sys_put_le32(control, d);
	sys_put_le32(input, d + 4);
	can_send8((node << 5) | 0x0B, d, 8);
}

static void set_input_vel(uint8_t node, float vel)
{
	uint8_t d[8];
	memcpy(d, &vel, 4);
	memset(d + 4, 0, 4);          /* torque feedforward 0 */
	can_send8((node << 5) | 0x0D, d, 8);
}

static void set_input_pos(uint8_t node, float pos)
{
	uint8_t d[8];
	memcpy(d, &pos, 4);
	memset(d + 4, 0, 4);          /* vel/torque feedforward 0 */
	can_send8((node << 5) | 0x0C, d, 8);
}

static void clear_errors(uint8_t node)
{
	uint8_t d[1] = { 0 };
	can_send8((node << 5) | 0x18, d, 1);
}

static void sdo_write_f32(uint8_t node, uint16_t endpoint, float v)
{
	uint8_t d[8];
	d[0] = 1;                     /* opcode: write */
	sys_put_le16(endpoint, &d[1]);
	d[3] = 0;
	memcpy(&d[4], &v, 4);
	can_send8((node << 5) | 0x04, d, 8);   /* RxSdo */
}

static void set_spinup_dir(uint8_t node, int8_t dir)
{
	if (nodes[node].ramp_dir == dir) {
		return;
	}
	sdo_write_f32(node, EP_SL_RAMP_VEL, dir * SL_RAMP_VEL_MAG);
	sdo_write_f32(node, EP_SL_RAMP_ACCEL, dir * SL_RAMP_ACC_MAG);
	nodes[node].ramp_dir = dir;
}

static void stop_node(uint8_t node)
{
	nodes[node].nudge_run = false;
	nodes[node].nudge_idle_at = 0;
	set_input_vel(node, 0.0f);
	set_axis_state(node, 1);      /* IDLE */
}

static void stop_all(void)
{
	for (int n = 0; n < MAX_NODES; n++) {
		if (nodes[n].seen) {
			stop_node(n);
		}
	}
}

static void ble_puts(const char *s)
{
	while (*s) {
		uart_poll_out(ble, *s++);
	}
}

static void handle_line(char *line)
{
	if (line[0] == '\0') {
		return;
	}
	printk("[cmd] %s\n", line);

	if (strcmp(line, "PING") == 0) {
		ble_puts("PONG\n");
		return;
	}

	char *cmd = strtok(line, ",");
	char *a1 = strtok(NULL, ",");
	char *a2 = strtok(NULL, ",");
	if (!cmd || !a1) {
		return;
	}
	int node = atoi(a1);
	if (node < 0 || node >= MAX_NODES) {
		return;
	}

	if (strcmp(cmd, "V") == 0 && a2) {
		float v = atoi(a2) / 1000.0f;  /* milli-turns/s -> turns/s */
		nodes[node].last_cmd_vel = v;
		nodes[node].cmd_vel = v;       /* track for synthetic HB */
		nodes[node].syn_active = true; /* enable synthetic heartbeats */
		set_input_vel(node, v);
	} else if (strcmp(cmd, "N") == 0 && a2) {
		/* timed burst (duration = turns/NUDGE_VEL). NOTE: terminating on
		 * the sensorless pos estimate was tried and reverted - the
		 * estimate jumps on spin-up re-init and ends bursts instantly. */
		float turns = atoi(a2) / 1000.0f;
		if (turns != 0.0f) {
			/* encoder era: exact position step, drive holds after.
			 * (velocity bursts died in the ramp - drive never reached
			 * speed inside the burst window) */
			clear_errors(node);
			set_controller_mode(node, 3, 5);   /* POSITION, TRAP_TRAJ */
			set_axis_state(node, 8);
			k_sleep(K_MSEC(80));               /* arming resets setpoints */
			set_input_pos(node, nodes[node].pos + turns);
			nodes[node].nudge_run = false;
		}
	} else if (strcmp(cmd, "GO") == 0) {
		/* closed-loop era: encoder is real, velocity sign just works.
		 * NO SDO writes - the 0.6.11 endpoint IDs corrupt 0.6.12 config. */
		clear_errors(node);
		set_controller_mode(node, 2, 2);   /* VELOCITY_CONTROL, VEL_RAMP */
		set_axis_state(node, 8);           /* CLOSED_LOOP_CONTROL */
		/* arming resets setpoints - re-send the host's velocity */
		k_sleep(K_MSEC(80));
		set_input_vel(node, nodes[node].last_cmd_vel);
	} else if (strcmp(cmd, "STOP") == 0) {
		stop_node(node);
	} else if (strcmp(cmd, "CLR") == 0) {
		clear_errors(node);
	}
}

int main(void)
{
	if (!device_is_ready(can_dev) || !device_is_ready(ble)) {
		printk("device not ready\n");
		return 0;
	}

	int ret = can_start(can_dev);
	if (ret != 0 && ret != -EALREADY) {
		printk("can_start: %d\n", ret);
	}
	const struct can_filter all = { .id = 0, .mask = 0, .flags = 0 };
	can_add_rx_filter(can_dev, can_rx_cb, NULL, &all);

	printk("=== teleop bridge: BLE<->CAN ===\n");

	/* Burst-then-parse: the RNBD forwards each BLE packet as one contiguous
	 * 115200 burst. With a 1-byte RX buffer, ANY blocking work (printk, CAN)
	 * mid-burst loses the rest of the packet. So: drain bytes hot until the
	 * line has been idle ~3 ms, then parse and act at leisure. */
	static char burst[512];
	int bn = 0;
	char line[96];
	int ll = 0;
	bool in_status = false;   /* RN status msgs are %...% delimited, no newline */
	struct can_frame f;
	int64_t last_hb = 0;
	int64_t last_byte = 0;
	unsigned char c;

	static int64_t last_alive = 0;
	static int loop_count = 0;

	while (1) {
		loop_count++;
		/* periodic alive message every 2 seconds */
		if (k_uptime_get() - last_alive > 2000) {
			printk("[ALIVE] loop=%d bn=%d\n", loop_count, bn);
			last_alive = k_uptime_get();
		}

		/* hot byte pump - nothing blocking in here */
		while (uart_poll_in(ble, &c) == 0) {
			if (bn < (int)sizeof(burst)) {
				burst[bn++] = c;
			}
			last_byte = k_uptime_get();
		}

		/* burst complete? parse it (blocking work is safe now) */
		if (bn > 0 && k_uptime_get() - last_byte >= 3) {
			printk("[BURST] parsing %d bytes\n", bn);
			for (int i = 0; i < bn; i++) {
				c = burst[i];
				if (in_status) {
					if (c == '%') {
						line[ll] = '\0';
						printk("[ble status] %%%s%%\n", line);
						if (strstr(line, "DISCONNECT")) {
							printk("BLE dropped - stopping all\n");
							stop_all();
						}
						ll = 0;
						in_status = false;
					} else if (ll < (int)sizeof(line) - 1) {
						line[ll++] = c;
					}
				} else if (ll == 0 && c == '%') {
					in_status = true;
				} else if (c == '\n' || c == '\r') {
					line[ll] = '\0';
					handle_line(line);
					ll = 0;
				} else if (ll < (int)sizeof(line) - 1) {
					line[ll++] = c;
				}
			}
			bn = 0;
		}

		/* CAN frames -> node state */
		while (k_msgq_get(&canq, &f, K_NO_WAIT) == 0) {
			uint8_t node = (f.id >> 5) & 0x3F;
			uint8_t cmd = f.id & 0x1F;
			if (node >= MAX_NODES) {
				continue;
			}
			nodes[node].seen = true;
			if (cmd == 0x01 && can_dlc_to_bytes(f.dlc) >= 5) {
				nodes[node].err = sys_get_le32(&f.data[0]);
				nodes[node].state = f.data[4];
			} else if (cmd == 0x09 && can_dlc_to_bytes(f.dlc) >= 8) {
				float p, v;
				memcpy(&p, &f.data[0], 4);
				memcpy(&v, &f.data[4], 4);
				nodes[node].pos = p;
				nodes[node].vel = v;
			}
		}

		/* nudge burst end + post-burst idle */
		for (int n = 0; n < MAX_NODES; n++) {
			int64_t now = k_uptime_get();
			if (nodes[n].nudge_run && now >= nodes[n].nudge_deadline) {
				nodes[n].nudge_run = false;
				set_input_vel(n, 0.0f);
				nodes[n].nudge_idle_at = now + 700;
			}
			if (nodes[n].nudge_idle_at && now >= nodes[n].nudge_idle_at) {
				nodes[n].nudge_idle_at = 0;
				set_axis_state(n, 1);
			}
		}

		/* integrate synthetic position from commanded velocity */
		int64_t now_integrate = k_uptime_get();
		if (last_integrate > 0) {
			float dt = (now_integrate - last_integrate) / 1000.0f;
			for (int n = 0; n < MAX_NODES; n++) {
				if (nodes[n].syn_active) {
					nodes[n].syn_pos += nodes[n].cmd_vel * dt;
				}
			}
		}
		last_integrate = now_integrate;

		/* periodic status upstream */
		if (k_uptime_get() - last_hb > 500) {
			last_hb = k_uptime_get();
			printk("[HB_LOOP] checking nodes\n");
			for (int n = 0; n < MAX_NODES; n++) {
				/* real motor heartbeat */
				if (nodes[n].seen) {
					char out[64];
					snprintf(out, sizeof(out), "HB,%d,%u,%08X,%d,%d\n",
						 n, nodes[n].state, nodes[n].err,
						 (int)(nodes[n].vel * 1000.0f),
						 (int)(nodes[n].pos * 1000.0f));
					ble_puts(out);
					printk("%s", out);
				}
				/* synthetic heartbeat (no real motor, but commands received) */
				else if (nodes[n].syn_active) {
					char out[64];
					snprintf(out, sizeof(out), "HB,%d,8,0,%d,%d\n",
						 n,
						 (int)(nodes[n].cmd_vel * 1000.0f),
						 (int)(nodes[n].syn_pos * 1000.0f));
					ble_puts(out);
					printk("%s", out);  /* SSE relay */
				}
			}
		}
	}
	return 0;
}
