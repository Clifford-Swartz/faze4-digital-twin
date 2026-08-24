/* RNBD451 bridge - poll-based (no-nap), the architecture that produced clean
 * CMD> responses. CONFIG_UART_INTERRUPT_DRIVEN breaks the sam usart driver
 * console-wide in this Zephyr version - do not reintroduce without retest. */
#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/sys/printk.h>

static const struct device *const ble_uart = DEVICE_DT_GET(DT_NODELABEL(uart3));

static void ble_send(const char *s)
{
	while (*s) {
		uart_poll_out(ble_uart, *s++);
	}
}

/* no-sleep drain: single-byte rx buffer, napping loses ~11 chars/ms */
static void relay(int ms)
{
	int64_t t0 = k_uptime_get();
	unsigned char c;

	while (k_uptime_get() - t0 < ms) {
		if (uart_poll_in(ble_uart, &c) == 0) {
			if ((c >= 0x20 && c < 0x7F) || c == '\r' || c == '\n') {
				printk("%c", c);
			} else {
				printk("<%02X>", c);
			}
		}
	}
}

int main(void)
{
	if (!device_is_ready(ble_uart)) {
		printk("uart3 not ready\n");
		return 0;
	}
	printk("=== RNBD451 bridge (poll) ===\n");
	k_msleep(1500);
	ble_send("$$$");
	relay(600);

	/* one-time proof-of-life, then transparent relay */
	printk("\n[version check]\n");
	ble_send("\r");
	relay(300);
	ble_send("V\r");
	relay(900);
	printk("\n[exiting command mode -> transparent UART]\n");
	ble_send("---\r");
	relay(500);
	printk("\n[bridge live: connect phone to RNBD451_667B - everything it sends appears below]\n");
	while (1) {
		relay(3600000);
	}
	return 0;
}


