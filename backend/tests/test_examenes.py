"""Fase 5: exámenes serios (intercambio, banco, sorteo, tiempo, integridad, reclamos)."""

import pytest

from app.interchange import InterchangeError, export_gift, parse_aiken, parse_gift, parse_moodle_xml
from tests.conftest import new_client, register

API = "/api/v1/survey"

GIFT = """// banco de prueba
::Capital:: ¿Capital de Francia? {=París ~Lyon ~Niza}

::VF:: El sol es una estrella {T}

::Num:: ¿Cuánto es 2+2? {#4:0.5}

::Corta:: Río más largo {=Amazonas =Río Amazonas}

::Varias:: Elegí los primos {~%50%2 ~%50%3 ~%-100%4}

::Ensayo:: Explicá la fotosíntesis {}

::Emparejar:: Uní {=a -> 1 =b -> 2}
"""


def test_gift_se_lee_con_clave_y_avisa_lo_que_no_soporta():
    r = parse_gift(GIFT)
    tipos = [(q.element["type"], q.grading.get("correct")) for q in r.questions]
    assert tipos == [
        ("radiogroup", "París"), ("boolean", True), ("text", 4.0),
        ("text", ["Amazonas", "Río Amazonas"]), ("checkbox", ["2", "3"]), ("comment", None),
    ]
    assert r.questions[2].element["inputType"] == "number" and r.questions[2].grading["tolerance"] == 0.5
    assert r.questions[5].grading["grader"] == "llm"
    assert r.warnings == ["Emparejamiento no soportado: «Uní»"]


def test_aiken_y_moodle_ida_y_vuelta():
    a = parse_aiken("¿Planeta más grande?\nA. Marte\nB. Júpiter\nANSWER: B\n")
    assert a.questions[0].grading["correct"] == "Júpiter"
    r = parse_gift(GIFT)
    schema = {"pages": [{"elements": [q.element for q in r.questions]}]}
    ev = {"questions": {q.element["name"]: q.grading for q in r.questions}}
    from app.interchange import export_moodle_xml

    xml, _ = export_moodle_xml(schema, ev)
    vuelta = parse_moodle_xml(xml)
    assert [(q.element["type"], q.grading.get("correct")) for q in vuelta.questions] == \
        [(q.element["type"], q.grading.get("correct")) for q in r.questions]
    texto, avisos = export_gift(schema, ev)
    assert "{=París ~Lyon ~Niza}" in texto and "{T}" in texto and avisos == []


def test_xml_con_entidades_se_rechaza():
    bomba = '<?xml version="1.0"?><!DOCTYPE q [<!ENTITY a "aaaa">]><quiz>&a;</quiz>'
    with pytest.raises(InterchangeError):
        parse_moodle_xml(bomba)


def test_importar_y_exportar_por_api():
    c = new_client(); register(c)
    s = c.post(f"{API}/surveys", json={"title": "T"}).json()
    r = c.post(f"{API}/surveys/{s['id']}/questions/import", data={"text": GIFT})
    assert r.status_code == 200, r.text
    out = r.json()
    assert len(out["elements"]) == 6 and out["warnings"]
    nombre = out["elements"][0]["name"]
    assert out["evaluation_questions"][nombre]["correct"] == "París"
    c.put(f"{API}/surveys/{s['id']}", json={
        "json_schema": {"pages": [{"name": "p", "elements": out["elements"]}]},
        "evaluation": {"enabled": True, "questions": out["evaluation_questions"]},
    })
    g = c.get(f"{API}/surveys/{s['id']}/questions/export?format=gift")
    assert g.status_code == 200 and "=París" in g.text
    x = c.get(f"{API}/surveys/{s['id']}/questions/export?format=moodle")
    assert x.status_code == 200 and "<quiz>" in x.text and 'type="essay"' in x.text
    vacio = c.post(f"{API}/surveys/{s['id']}/questions/import", data={"text": "nada que ver"})
    assert vacio.status_code == 422


def test_banco_guardar_filtrar_importar_y_estadisticas():
    c = new_client(); register(c)
    el = {"type": "radiogroup", "name": "cap", "title": "Capital de Francia", "choices": ["París", "Lyon"],
          "visibleIf": "{otra} = 1"}
    r = c.post(f"{API}/bank", json={"items": [
        {"element": el, "grading": {"gradable": True, "grader": "auto", "points": 1, "correct": "París"},
         "topic": "Geografía", "tags": ["Europa", "europa", " capitales "], "bloom": "recordar"}]})
    assert r.status_code == 201
    item = r.json()["items"][0]
    # La lógica que apuntaba a otras preguntas de la encuesta de origen no viaja.
    assert "visibleIf" not in item["element"] and item["tags"] == ["Europa", "capitales"]
    c.post(f"{API}/bank/import", data={"text": GIFT, "topic": "Varios", "tags": "gift"})
    f = c.get(f"{API}/bank/facets").json()
    assert f["total"] == 7 and {"value": "Geografía", "count": 1} in f["topics"]
    assert [i["title"] for i in c.get(f"{API}/bank?topic=Geografía").json()] == ["Capital de Francia"]
    assert len(c.get(f"{API}/bank?q=capital").json()) == 2  # "Capital de Francia" y la de GIFT
    assert len(c.get(f"{API}/bank?tag=gift").json()) == 6

    # Se usa en un examen (el editor inserta el elemento con encBankId) y se responde.
    usado = {**item["element"], "name": "p1", "encBankId": item["id"]}
    s = c.post(f"{API}/surveys", json={"title": "Parcial", "json_schema": {"pages": [{"elements": [usado]}]},
                                       "evaluation": {"enabled": True, "questions": {"p1": item["grading"]}}}).json()
    c.post(f"{API}/surveys/{s['id']}/publish")
    for resp in ["París", "París", "Lyon", "París"]:
        new_client().post(f"{API}/public/{s['slug']}/submit", json={"answers": {"p1": resp}})
    st = c.get(f"{API}/bank/{item['id']}/stats").json()
    assert st["used_in"] == 1 and st["responses"] == 4 and st["difficulty"] == 0.75

    # Otra organización no lo ve.
    otro = new_client(); register(otro)
    assert otro.get(f"{API}/bank").json() == []
    assert otro.delete(f"{API}/bank/{item['id']}").status_code == 404
