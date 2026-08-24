# SAME70 firmware (Zephyr)

Four Zephyr apps for the ATSAME70 Xplained Ultra (`sam_e70_xplained/same70q21b`)
that bridge the browser to the ODrive S1 drives over CAN.

| App | What it does |
|---|---|
| `teleop` | The real bridge: RNBD451 BLE module on UART3 ↔ CANSimple to the ODrives. Line protocol in (`V`, `GO`, `STOP`, `N` position nudges, `PING`), heartbeats out (`HB,<node>,<state>,<err>,<mvel>,<mpos>` at 2 Hz per seen node). Nudges run in position mode (trap-traj) so quick taps land exactly and hold. |
| `ble_bridge` | Earlier UART↔BLE bring-up app for the RNBD451. |
| `can_cruise` | Standalone smoke test: arms node 0 and runs a velocity plan (±2, ±5 rev/s) with live telemetry on the EDBG console. No BLE involved. |
| `can_sniffer` | Prints every CAN frame it hears — first thing to flash when the bus misbehaves. |

## Build & flash

```
west build -d build_teleop firmware/teleop     # from your zephyr workspace
west flash -d build_teleop                     # OpenOCD via the onboard EDBG
```

## Wiring (teleop)

- RNBD451 TX → EXT1 pin 9 (PD28, UART3 RX)
- RNBD451 RX → EXT2 pin 3 (PD30, UART3 TX)
- GND → EXT1 pin 19; module powered by USB (power-only source — a host PC
  enumerates the module's onboard USB-serial chip, which fights the SAME70
  for the RX net)
- CAN1 on PC12/PC14 through the onboard transceiver, 250 kbit/s

Hard-won notes: the module back-powers through the SAME70's idle-high TX pin,
so a true reboot means unplugging both the module and the board until the LED
is fully dark. ODrive setpoints reset when entering closed loop — arm first,
sleep ~80 ms, then write the setpoint.
