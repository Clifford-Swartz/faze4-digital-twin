/*
 * can_cruise: the SAME70 drives J1 by itself over CANSimple.
 *
 * Boot -> wait 3 s -> clear errors -> VELOCITY_CONTROL/VEL_RAMP ->
 * CLOSED_LOOP -> cruise {+2, -2, +5, -5, 0} rev/s (4 s each, ramps happen
 * drive-side at the saved vel_ramp_rate) -> vel 0 -> IDLE -> halt.
 *
 * Telemetry on the EDBG console (115200): commanded vs measured vel from
 * the S1's cyclic encoder frames (0x09), plus heartbeat state/error.
 * Aborts to IDLE on any nonzero axis error.
 *
 * NO SDO writes anywhere - the teleop app's 0.6.11-era endpoint pokes
 * corrupted 0.6.12 config (calibration_current). CANSimple commands only.
 *
 * CAN1 PC12/PC14 via the onboard transceiver, 250 kbit/s. J1 = node 0.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/can.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/byteorder.h>
#include <string.h>

static const struct device *const can_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_canbus));

#define NODE 0

static struct {
	volatile uint8_t state;
	volatile uint32_t err;
	volatile float pos, vel;
	volatile bool hb_seen, enc_seen;
} j1;

static void can_rx_cb(const struct device *dev, struct can_frame *f, void *ud)
{
	ARG_UNUSED(dev); ARG_UNUSED(ud);
	uint8_t node = f->id >> 5;
	uint8_t cmd = f->id & 0x1F;

	if (node != NODE) {
		return;
	}
	if (cmd == 0x01 && can_dlc_to_bytes(f->dlc) >= 5) {
		j1.err = sys_get_le32(&f->data[0]);
		j1.state = f->data[4];
		j1.hb_seen = true;
	} else if (cmd == 0x09 && can_dlc_to_bytes(f->dlc) >= 8) {
		float p, v;
		memcpy(&p, &f->data[0], 4);
		memcpy(&v, &f->data[4], 4);
		j1.pos = p;
		j1.vel = v;
		j1.enc_seen = true;
	}
}

static void can_send8(uint32_t id, const uint8_t *data, uint8_t len)
{
	struct can_frame f = { 0 };

	f.id = id;
	f.dlc = can_bytes_to_dlc(len);
	memcpy(f.data, data, len);
	int r = can_send(can_dev, &f, K_MSEC(20), NULL, NULL);
	if (r != 0) {
		printk("can_send 0x%03X failed: %d\n", id, r);
	}
}

static void set_axis_state(uint32_t state)
{
	uint8_t d[4];
	sys_put_le32(state, d);
	can_send8((NODE << 5) | 0x07, d, 4);
}

static void set_controller_mode(uint32_t control, uint32_t input)
{
	uint8_t d[8];
	sys_put_le32(control, d);
	sys_put_le32(input, d + 4);
	can_send8((NODE << 5) | 0x0B, d, 8);
}

static void set_input_vel(float vel)
{
	uint8_t d[8];
	memcpy(d, &vel, 4);
	memset(d + 4, 0, 4);
	can_send8((NODE << 5) | 0x0D, d, 8);
}

static void clear_errors(void)
{
	uint8_t d[1] = { 0 };
	can_send8((NODE << 5) | 0x18, d, 1);
}

static bool abort_if_error(void)
{
	if (j1.err != 0) {
		printk("!! axis error 0x%08X - stopping\n", j1.err);
		set_input_vel(0.0f);
		set_axis_state(1);
		return true;
	}
	return false;
}

int main(void)
{
	if (!device_is_ready(can_dev)) {
		printk("CAN device not ready\n");
		return 0;
	}
	can_start(can_dev);

	const struct can_filter filt = { .id = 0, .mask = 0 };
	can_add_rx_filter(can_dev, can_rx_cb, NULL, &filt);

	printk("\n=== can_cruise: SAME70 drives J1 (node %d) ===\n", NODE);
	k_sleep(K_SECONDS(3));

	if (!j1.hb_seen) {
		printk("no heartbeat from node %d yet - check CAN wiring\n", NODE);
		while (!j1.hb_seen) {
			k_sleep(K_MSEC(500));
		}
	}
	printk("heartbeat ok: state %u err 0x%08X\n", j1.state, j1.err);

	/* retry forever: the bench encoder connector flaps; arm the moment
	 * the S1 is healthy again (reseat -> self-start, no reflash) */
	int attempt = 0;
	for (;;) {
		attempt++;
		clear_errors();
		k_sleep(K_MSEC(400));
		set_controller_mode(2, 2);    /* VELOCITY_CONTROL, VEL_RAMP */
		k_sleep(K_MSEC(100));
		set_axis_state(8);            /* CLOSED_LOOP_CONTROL */

		int64_t t0 = k_uptime_get();
		while (j1.state != 8 && k_uptime_get() - t0 < 3000) {
			k_sleep(K_MSEC(100));
		}
		if (j1.state == 8) {
			break;
		}
		printk("arm attempt %d: state %u err 0x%08X - retrying\n",
		       attempt, j1.state, j1.err);
		set_axis_state(1);
		k_sleep(K_SECONDS(3));
	}
	printk("armed: CLOSED_LOOP\n");

	static const float plan[] = { 2.0f, -2.0f, 5.0f, -5.0f, 0.0f };
	bool pass = true;

	for (int i = 0; i < ARRAY_SIZE(plan); i++) {
		float tgt = plan[i];

		set_input_vel(tgt);
		printk("-- cmd %+d.%d rev/s\n", (int)tgt,
		       (int)(10 * (tgt - (int)tgt)) * ((tgt < 0) ? -1 : 1));

		for (int s = 0; s < 4; s++) {
			k_sleep(K_SECONDS(1));
			if (abort_if_error()) {
				return 0;
			}
			int mv = (int)(j1.vel * 100);
			printk("   t+%ds: vel %d.%02d rev/s (state %u)\n",
			       s + 1, mv / 100, (mv < 0 ? -mv : mv) % 100, j1.state);
		}
		float diff = j1.vel - tgt;
		if (diff < 0) {
			diff = -diff;
		}
		if (diff > 0.8f) {
			pass = false;
			printk("   MISS: settled off target\n");
		}
	}

	set_input_vel(0.0f);
	k_sleep(K_MSEC(800));
	set_axis_state(1);
	printk("=== cruise %s - motor idled ===\n", pass ? "PASS" : "FAIL");
	return 0;
}
