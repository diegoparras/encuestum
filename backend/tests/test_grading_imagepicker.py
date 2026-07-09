from app.grading import grade_deterministic


def test_imagepicker_single_like_radiogroup():
    cfg = {"points": 2, "correct": ["Gato"], "multiSelect": False, "gradable": True}
    assert grade_deterministic(cfg, "imagepicker", "Gato")["awarded"] == 2
    assert grade_deterministic(cfg, "imagepicker", "Perro")["awarded"] == 0


def test_imagepicker_multi_like_checkbox():
    cfg = {"points": 3, "correct": ["A", "B"], "multiSelect": True, "gradable": True}
    assert grade_deterministic(cfg, "imagepicker", ["A", "B"])["awarded"] == 3
    # exact match required without partial credit
    assert grade_deterministic(cfg, "imagepicker", ["A"])["awarded"] == 0


def test_imagepicker_multi_partial():
    cfg = {"points": 4, "correct": ["A", "B"], "multiSelect": True, "partialCredit": True, "gradable": True}
    r = grade_deterministic(cfg, "imagepicker", ["A"])
    assert 0 < r["awarded"] < 4  # partial
