"""Filtros y cross-tab (segmentación) del resumen de resultados.

La lógica vive en build_summary (pura), así que se prueba directo sobre ella:
más rápido y sin montar respuestas por HTTP."""

from app.summarizing import build_summary, filterable_questions


class _R:
    """Stub de SurveyResponse: build_summary solo mira .answers."""

    def __init__(self, answers):
        self.answers = answers


SCHEMA = {
    "pages": [
        {
            "elements": [
                {
                    "type": "radiogroup",
                    "name": "depto",
                    "title": "Departamento",
                    "choices": [
                        {"value": "ventas", "text": "Ventas"},
                        {"value": "sop", "text": "Soporte"},
                    ],
                },
                {"type": "rating", "name": "sat", "title": "Satisfacción", "rateMin": 1, "rateMax": 5},
                {"type": "comment", "name": "coment", "title": "Comentarios"},
            ]
        }
    ]
}


def _data():
    return [
        _R({"depto": "ventas", "sat": 5, "coment": "genial"}),
        _R({"depto": "ventas", "sat": 3, "coment": "ok"}),
        _R({"depto": "sop", "sat": 1, "coment": "lento"}),
        _R({"depto": "sop", "sat": 2}),
    ]


def test_filterable_lists_only_categorical():
    fq = filterable_questions(SCHEMA)
    names = {q["name"] for q in fq}
    assert names == {"depto"}  # rating y comment no son dimensiones
    assert fq[0]["options"] == [
        {"value": "ventas", "label": "Ventas"},
        {"value": "sop", "label": "Soporte"},
    ]


def test_filter_restricts_universe():
    out = build_summary(SCHEMA, _data(), filters=[{"name": "depto", "values": ["ventas"]}])
    assert out["total_responses"] == 4
    assert out["filtered_responses"] == 2
    sat = next(q for q in out["questions"] if q["name"] == "sat")
    # Solo Ventas: 5 y 3 → promedio 4.
    assert sat["average"] == 4.0


def test_segment_by_crosstabs_rating_average():
    out = build_summary(SCHEMA, _data(), segment_by="depto")
    seg = out["segment"]
    assert seg["name"] == "depto"
    assert [v["value"] for v in seg["values"]] == ["ventas", "sop"]
    assert [v["count"] for v in seg["values"]] == [2, 2]

    sat = next(q for q in out["questions"] if q["name"] == "sat")
    assert "by_segment" in sat
    assert sat["by_segment"]["ventas"]["average"] == 4.0  # (5+3)/2
    assert sat["by_segment"]["sop"]["average"] == 1.5  # (1+2)/2


def test_segment_question_has_no_self_breakdown():
    out = build_summary(SCHEMA, _data(), segment_by="depto")
    depto = next(q for q in out["questions"] if q["name"] == "depto")
    # La pregunta que ES el segmento no se cruza consigo misma.
    assert "by_segment" not in depto


def test_text_questions_are_not_segmented():
    out = build_summary(SCHEMA, _data(), segment_by="depto")
    com = next(q for q in out["questions"] if q["name"] == "coment")
    assert com["kind"] == "text"
    assert "by_segment" not in com


def test_filter_and_segment_combine():
    # Filtrar a satisfacción alta (no se puede con rating), así que combinamos
    # filtro por depto y segmento por depto: debe quedar un solo segmento.
    out = build_summary(
        SCHEMA, _data(),
        filters=[{"name": "depto", "values": ["sop"]}],
        segment_by="depto",
    )
    assert out["filtered_responses"] == 2
    assert [v["value"] for v in out["segment"]["values"]] == ["sop"]


def test_bogus_filter_name_is_ignored_safely():
    out = build_summary(SCHEMA, _data(), filters=[{"name": "no_existe", "values": ["x"]}])
    # Un filtro sobre una pregunta inexistente se descarta (no vacía el universo).
    assert out["filtered_responses"] == 4
    assert out["filters"] == []
