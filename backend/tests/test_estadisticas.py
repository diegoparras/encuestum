"""Estadísticas de la Fase 2: agregados nuevos, tiempo, significancia, texto."""

from datetime import date, datetime, timedelta, timezone

from app import stats
from app.summarizing import build_summary, crosstab_rows


class _R:
    def __init__(self, answers, when=None):
        self.answers = answers
        self.submitted_at = when


def _q(out, name):
    return next(q for q in out["questions"] if q["name"] == name)


SCHEMA = {"pages": [{"elements": [
    {"type": "radiogroup", "name": "depto", "title": "Depto",
     "choices": [{"value": "v", "text": "Ventas"}, {"value": "s", "text": "Soporte"}]},
    {"type": "radiogroup", "name": "vuelve", "title": "¿Volvería?", "choices": ["Sí", "No"]},
    {"type": "rating", "name": "nps", "title": "Recomendaría", "rateMin": 0, "rateMax": 10},
    {"type": "matrix", "name": "m", "title": "Atención",
     "rows": [{"value": "rapidez", "text": "Rapidez"}, {"value": "trato", "text": "Trato"}],
     "columns": [{"value": "mal", "text": "Mal"}, {"value": "bien", "text": "Bien"}]},
    {"type": "ranking", "name": "rk", "title": "Prioridades", "choices": ["Precio", "Calidad", "Plazo"]},
    {"type": "text", "inputType": "number", "name": "edad", "title": "Edad"},
    {"type": "text", "inputType": "date", "name": "nac", "title": "Fecha"},
    {"type": "checkbox", "name": "canal", "title": "Canales", "choices": ["Web", "Tel"]},
    {"type": "comment", "name": "op", "title": "Comentarios"},
]}]}


def test_nps_y_estadisticos_de_escala():
    rs = [_R({"nps": v}) for v in [10, 9, 9, 8, 7, 6, 3, 10, 0, 10]]
    q = _q(build_summary(SCHEMA, rs), "nps")
    # 5 promotores (9-10), 3 detractores (0-6) sobre 10 → NPS 20.
    assert q["nps"] == {"score": 20, "promoters": 5, "passives": 2, "detractors": 3}
    assert q["median"] == 8.5
    assert q["top2"] == 50.0 and q["bottom2"] == 10.0
    assert q["stdev"] is not None


def test_matriz_ranking_numero_y_fecha():
    rs = [
        _R({"m": {"rapidez": "mal", "trato": "bien"}, "rk": ["Calidad", "Precio", "Plazo"],
            "edad": "30", "nac": "1990-05-10"}),
        _R({"m": {"rapidez": "bien", "trato": "bien"}, "rk": ["Calidad", "Plazo", "Precio"],
            "edad": 40, "nac": "1985-05-02"}),
        _R({"m": {"rapidez": "mal"}, "rk": ["Precio", "Calidad", "Plazo"], "edad": "x", "nac": "2001-01-01"}),
    ]
    out = build_summary(SCHEMA, rs)
    m = _q(out, "m")
    assert m["kind"] == "matrix" and m["cells"] == [[2, 1], [0, 2]]
    rk = _q(out, "rk")
    assert rk["kind"] == "ranking"
    assert rk["items"][0]["label"] == "Calidad" and rk["items"][0]["first"] == 2
    assert rk["items"][0]["avg_position"] == 1.33
    edad = _q(out, "edad")
    assert edad["kind"] == "numeric" and edad["n"] == 2 and edad["average"] == 35.0
    nac = _q(out, "nac")
    assert nac["kind"] == "dates" and nac["min"] == "1985-05-02"
    assert nac["by_month"] == [{"month": "1985-05", "count": 1}, {"month": "1990-05", "count": 1},
                               {"month": "2001-01", "count": 1}]


def test_rango_de_fechas_y_serie_diaria():
    d0 = datetime(2026, 11, 1, 12, tzinfo=timezone.utc)
    rs = [_R({"depto": "v"}, d0), _R({"depto": "v"}, d0 + timedelta(days=2)),
          _R({"depto": "s"}, d0 + timedelta(days=5))]
    out = build_summary(SCHEMA, rs, date_from=date(2026, 11, 2), date_to=date(2026, 11, 5))
    assert out["filtered_responses"] == 1
    todo = build_summary(SCHEMA, rs)
    assert [p["count"] for p in todo["timeline"]] == [1, 0, 1, 0, 0, 1]


def test_la_diferencia_entre_segmentos_se_prueba_y_avisa_si_la_muestra_es_chica():
    rs = ([_R({"depto": "v", "vuelve": "Sí"}) for _ in range(40)]
          + [_R({"depto": "v", "vuelve": "No"}) for _ in range(10)]
          + [_R({"depto": "s", "vuelve": "Sí"}) for _ in range(15)]
          + [_R({"depto": "s", "vuelve": "No"}) for _ in range(35)])
    out = build_summary(SCHEMA, rs, segment_by="depto")
    sig = _q(out, "vuelve")["significance"]
    assert sig["significant"] is True and sig["p"] < 0.001 and sig["reliable"]
    assert out["segment"]["small_sample"] is False

    pocos = build_summary(SCHEMA, rs[:3] + rs[40:42] + rs[50:52] + rs[65:68], segment_by="depto")
    assert pocos["segment"]["small_sample"] is True
    assert _q(pocos, "vuelve")["significance"]["significant"] is False

    planilla = crosstab_rows(out)
    assert planilla[0][:2] == ["Pregunta", "Opción"]
    assert planilla[1][0] == "¿Volvería?" and planilla[1][2] == 40


def test_segmentar_por_casillas_cuenta_a_cada_persona_en_lo_que_marco():
    rs = [_R({"canal": ["Web", "Tel"], "vuelve": "Sí"}), _R({"canal": ["Web"], "vuelve": "No"})]
    out = build_summary(SCHEMA, rs, segment_by="canal")
    assert [v["count"] for v in out["segment"]["values"]] == [2, 1]
    # Columnas no independientes: no se ofrece un chi² engañoso.
    assert "significance" not in _q(out, "vuelve")


def test_terminos_frecuentes_en_abiertas():
    rs = [_R({"op": t}) for t in ["El precio es alto", "Precio alto, mala atención",
                                  "Mala atención en el local", "Buen precio"]]
    terms = {t["term"]: t["count"] for t in _q(build_summary(SCHEMA, rs), "op")["terms"]}
    assert terms["precio"] == 3 and terms["mala atencion"] == 2


def test_chi2_y_alfa_contra_valores_de_referencia():
    assert round(stats.chi2_sf(3.841, 1), 3) == 0.05
    assert round(stats.chi2_sf(10, 4), 4) == 0.0404
    # Cinco personas, tres ítems 0/1: KR-20 calculado a mano = 0.4615.
    a = stats.cronbach_alpha([[1, 1, 1], [1, 0, 1], [0, 0, 1], [0, 0, 0], [1, 1, 0]])
    assert round(a, 4) == 0.4615


def test_analisis_de_items_detecta_clave_mal_cargada_y_distractores():
    from app.item_analysis import analyze

    buenos = ["q1", "q2", "q3", "q4", "q5"]
    umbral = {"q1": 4, "q2": 6, "q3": 8, "q4": 10, "q5": 12}
    schema = {"pages": [{"elements": [
        *[{"type": "radiogroup", "name": n, "choices": ["ok", "mal", "nadie"]} for n in buenos],
        {"type": "radiogroup", "name": "c", "choices": ["si", "no"]},
    ]}]}
    ev = {"questions": {**{n: {"correct": "ok"} for n in buenos}, "c": {"correct": "si"}}}

    class G:
        def __init__(self, notas, ans):
            self.grade = {"questions": [{"name": k, "points": 1, "awarded": v} for k, v in notas.items()],
                          "percent": round(100 * sum(notas.values()) / len(notas), 1)}
            self.answers = ans

    gente = []
    for i in range(20):  # i = "habilidad" de la persona
        notas = {n: 1 if i >= umbral[n] else 0 for n in buenos}
        # `c` la aciertan los que MENOS saben: clave mal cargada.
        notas["c"] = 1 if i < 10 else 0
        ans = {n: "ok" if notas[n] else "mal" for n in buenos}
        ans["c"] = "si" if notas["c"] else "no"
        gente.append(G(notas, ans))

    out = analyze(schema, ev, gente)
    assert "discriminacion_negativa" in out["items"]["c"]["flags"]
    assert out["items"]["q3"]["discrimination"] > 0.5
    assert out["items"]["q3"]["d_index"] == 1.0
    assert out["items"]["q1"]["difficulty"] == 0.8
    # Nadie eligió "nadie": esa opción no distrae a nadie.
    assert out["items"]["q3"]["distractors"]["never_chosen"] == ["nadie"]
    assert "distractor_inutil" in out["items"]["q3"]["flags"]
    # En `c`, la opción incorrecta "no" la eligen los mejores alumnos.
    assert out["items"]["c"]["distractors"]["attracts_top"][0]["option"] == "no"
    assert out["reliability"]["items"] == 6 and out["reliability"]["n"] == 20


def test_calidad_marca_apuradas_en_linea_recta_y_duplicadas():
    from types import SimpleNamespace as NS

    from app.quality import assess

    schema = {"pages": [{"elements": [
        {"type": "matrix", "name": "m"}, {"type": "text", "name": "a"},
        {"type": "text", "name": "b"}, {"type": "text", "name": "c"},
    ]}]}
    base = datetime(2026, 11, 1, tzinfo=timezone.utc)

    def R(i, secs, answers, ip="ip1"):
        return NS(id=f"r{i}", answers=answers, submitted_at=base + timedelta(minutes=i),
                  meta={"server": {"seconds_since_first_view": secs, "ip_hash": ip}})

    rs = [R(i, 300, {"a": f"x{i}", "b": "y", "c": "z"}, ip=f"ip{i}") for i in range(10)]
    rs.append(R(10, 20, {"a": "rápido", "b": "y", "c": "z"}))
    rs.append(R(11, 300, {"m": {"f1": "1", "f2": "1", "f3": "1", "f4": "1"}, "a": "q"}))
    rs.append(R(12, 300, {"a": "x1", "b": "y", "c": "z"}, ip="ip1"))  # igual a r1, misma conexión
    out = assess(schema, rs)
    motivos = {f["response_id"]: {x["code"] for x in f["reasons"]} for f in out["flagged"]}
    assert motivos["r10"] == {"speeder"}
    assert motivos["r11"] == {"straight_line"}
    assert motivos["r12"] == {"duplicate"}
    assert "r1" not in motivos  # la original no se marca
    assert out["completion"]["median"] == 300
