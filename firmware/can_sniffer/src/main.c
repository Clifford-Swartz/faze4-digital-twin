/*
 * CAN sniffer — first contact between the SAME70 and an ODrive S1.
 *
 * Prints every CAN frame heard on the bus to the console (EDBG VCOM,
 * 115200), decoded per ODrive's CANSimple framing:
 *   11-bit id = node_id (6 bits) << 5 | cmd_id (5 bits)
 * A configured S1 broadcasts Heartbeat (cmd 0x01) every 100 ms — if this
 * program prints ticking heartbeats, the link works.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/can.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/byteorder.h>

static const struct device *const can_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_canbus));

K_MSGQ_DEFINE(frame_q, sizeof(struct can_frame), 32, 4);

static const char *axis_state_name(uint8_t s)
{
	switch (s) {
	case 0: return "UNDEFINED";
	case 1: return "IDLE";
	case 2: return "STARTUP_SEQUENCE";
	case 3: return "FULL_CALIBRATION";
	case 4: return "MOTOR_CALIBRATION";
	case 6: return "ENCODER_INDEX_SEARCH";
	case 7: return "ENCODER_OFFSET_CALIB";
	case 8: return "CLOSED_LOOP_CONTROL";
	case 9: return "LOCKIN_SPIN";
	case 10: return "ENCODER_DIR_FIND";
	case 11: return "HOMING";
	case 12: return "ENCODER_HALL_POLARITY";
	case 13: return "ENCODER_HALL_PHASE";
	case 14: return "ANTICOGGING_CALIB";
	default: return "?";
	}
}

static void rx_cb(const struct device *dev, struct can_frame *frame, void *user_data)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(user_data);
	k_msgq_put(&frame_q, frame, K_NO_WAIT);
}

int main(void)
{
	if (!device_is_ready(can_dev)) {
		printk("CAN device not ready\n");
		return 0;
	}

	int ret = can_start(can_dev);
	if (ret != 0 && ret != -EALREADY) {
		printk("can_start failed: %d\n", ret);
		return 0;
	}

	/* match-all filter */
	const struct can_filter filter = { .id = 0, .mask = 0, .flags = 0 };
	ret = can_add_rx_filter(can_dev, rx_cb, NULL, &filter);
	if (ret < 0) {
		printk("can_add_rx_filter failed: %d\n", ret);
		return 0;
	}

	printk("CAN sniffer up on %s @ 250 kbit/s. Listening...\n", can_dev->name);

	struct can_frame f;
	uint32_t n = 0;
	int64_t last_note = k_uptime_get();

	/* TX proof: CANSimple Clear_Errors (cmd 0x18) to node 0 with the
	 * Identify byte — 1 makes the S1 rapid-blink its LED, 0 restores it.
	 * Toggled every 5 s so the blink pattern is unmistakably ours. */
	int64_t last_identify = 0;
	uint8_t identify = 0;

	while (1) {
		if (k_uptime_get() - last_identify > 5000) {
			last_identify = k_uptime_get();
			identify ^= 1;
			struct can_frame tx = {
				.id = (0 << 5) | 0x18,   /* node 0, Clear_Errors */
				.dlc = 1,
				.flags = 0,
				.data = { identify },
			};
			int txr = can_send(can_dev, &tx, K_MSEC(100), NULL, NULL);
			printk(">>> sent Clear_Errors identify=%u (%s)\n", identify,
			       txr == 0 ? "ok" : "FAILED");
		}

		if (k_msgq_get(&frame_q, &f, K_MSEC(500)) == 0) {
			n++;
			uint8_t node = (f.id >> 5) & 0x3F;
			uint8_t cmd = f.id & 0x1F;

			printk("[%6u] id=0x%03X node=%u cmd=0x%02X dlc=%u  ",
			       n, f.id, node, cmd, can_dlc_to_bytes(f.dlc));
			for (int i = 0; i < can_dlc_to_bytes(f.dlc); i++) {
				printk("%02X ", f.data[i]);
			}

			if (cmd == 0x01 && can_dlc_to_bytes(f.dlc) >= 5) {
				uint32_t err = sys_get_le32(&f.data[0]);
				uint8_t state = f.data[4];
				printk(" | HEARTBEAT err=0x%08X state=%s", err,
				       axis_state_name(state));
			}
			printk("\n");
		} else if (k_uptime_get() - last_note > 5000) {
			last_note = k_uptime_get();
			printk("(alive, %u frames so far)\n", n);
		}
	}
	return 0;
}
