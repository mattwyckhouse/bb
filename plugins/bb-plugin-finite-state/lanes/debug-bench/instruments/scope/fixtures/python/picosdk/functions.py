def assert_pico_ok(status):
    if status != 0:
        raise RuntimeError("Pico status " + str(status))


def mV2adc(millivolts, _range_id, max_adc):
    return int(millivolts / 2000.0 * max_adc.value)


def adc2mV(buffer, _range_id, max_adc):
    return [sample / max_adc.value * 2000.0 for sample in buffer]
