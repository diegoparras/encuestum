"""Carpetas de encuestas: árbol, colores, mover y borrar.

Lo que más importa acá son dos invariantes: que no se pueda armar un ciclo (una
carpeta dentro de su propia descendencia colgaría cualquier recorrido) y que
borrar una carpeta no se lleve puesto el trabajo de nadie.
"""

from tests.conftest import new_client, register

API = "/api/v1/survey/folders"


def _crear(c, name, parent=None, color=None):
    body = {"name": name}
    if parent:
        body["parent_id"] = parent
    if color:
        body["color"] = color
    r = c.post(API, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _encuesta(c, title="E"):
    return c.post("/api/v1/survey/surveys", json={"title": title, "json_schema": {}}).json()


def test_arbol_con_subcarpetas_y_color_libre():
    c = new_client()
    register(c)
    raiz = _crear(c, "2026", color="#8faf0e")
    hija = _crear(c, "Primer cuatrimestre", parent=raiz["id"])
    nieta = _crear(c, "Marzo", parent=hija["id"])

    todas = c.get(API).json()
    por_id = {f["id"]: f for f in todas}
    assert por_id[raiz["id"]]["parent_id"] is None
    assert por_id[hija["id"]]["parent_id"] == raiz["id"]
    assert por_id[nieta["id"]]["parent_id"] == hija["id"]
    # Color libre, no una paleta cerrada.
    assert por_id[raiz["id"]]["color"] == "#8faf0e"


def test_color_invalido_se_rechaza():
    c = new_client()
    register(c)
    assert c.post(API, json={"name": "X", "color": "rojo"}).status_code == 422


def test_no_se_puede_armar_un_ciclo():
    c = new_client()
    register(c)
    abuela = _crear(c, "Abuela")
    madre = _crear(c, "Madre", parent=abuela["id"])
    nieta = _crear(c, "Nieta", parent=madre["id"])

    # Dentro de sí misma.
    assert c.patch(f"{API}/{abuela['id']}", json={"parent_id": abuela["id"]}).status_code == 400
    # Dentro de su hija…
    assert c.patch(f"{API}/{abuela['id']}", json={"parent_id": madre["id"]}).status_code == 400
    # …y dentro de su nieta (descendencia lejana).
    r = c.patch(f"{API}/{abuela['id']}", json={"parent_id": nieta["id"]})
    assert r.status_code == 400
    assert "subcarpetas" in r.json()["detail"]


def test_mover_encuestas_y_contarlas():
    c = new_client()
    register(c)
    f = _crear(c, "Clientes")
    a, b = _encuesta(c, "A"), _encuesta(c, "B")

    r = c.post(f"{API}/move-surveys", json={"survey_ids": [a["id"], b["id"]], "folder_id": f["id"]})
    assert r.json()["moved"] == 2
    assert c.get(API).json()[0]["survey_count"] == 2
    assert c.get(f"/api/v1/survey/surveys/{a['id']}").json()["folder_id"] == f["id"]

    # Y de vuelta a la raíz.
    c.post(f"{API}/move-surveys", json={"survey_ids": [a["id"]], "folder_id": None})
    assert c.get(f"/api/v1/survey/surveys/{a['id']}").json()["folder_id"] is None
    assert c.get(API).json()[0]["survey_count"] == 1


def test_borrar_una_carpeta_no_borra_encuestas():
    """Lo importante: ordenar nunca puede costar trabajo perdido."""
    c = new_client()
    register(c)
    padre = _crear(c, "Padre")
    hija = _crear(c, "Hija", parent=padre["id"])
    e = _encuesta(c, "Importante")
    c.post(f"{API}/move-surveys", json={"survey_ids": [e["id"]], "folder_id": hija["id"]})

    assert c.delete(f"{API}/{hija['id']}").status_code == 204

    # La encuesta sigue viva y subió al padre.
    detalle = c.get(f"/api/v1/survey/surveys/{e['id']}")
    assert detalle.status_code == 200
    assert detalle.json()["folder_id"] == padre["id"]


def test_al_borrar_las_subcarpetas_suben_un_nivel():
    c = new_client()
    register(c)
    abuela = _crear(c, "Abuela")
    madre = _crear(c, "Madre", parent=abuela["id"])
    nieta = _crear(c, "Nieta", parent=madre["id"])

    c.delete(f"{API}/{madre['id']}")

    por_id = {f["id"]: f for f in c.get(API).json()}
    assert madre["id"] not in por_id
    assert nieta["id"] in por_id  # no se borró en cascada
    assert por_id[nieta["id"]]["parent_id"] == abuela["id"]


def test_las_carpetas_son_de_la_organizacion():
    c = new_client()
    register(c)
    f = _crear(c, "Mía")

    ajeno = new_client()
    register(ajeno)
    assert ajeno.get(API).json() == []
    assert ajeno.patch(f"{API}/{f['id']}", json={"name": "Robada"}).status_code == 404
    assert ajeno.delete(f"{API}/{f['id']}").status_code == 404
