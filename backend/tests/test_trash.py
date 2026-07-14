"""Papelera (soft-delete) de encuestas: borrar no destruye, restaurar devuelve
todo, y purgar (irreversible) solo se permite desde la papelera."""

from tests.conftest import new_client, register

SCHEMA = {
    "pages": [
        {"elements": [{"type": "text", "name": "q1", "title": "¿Nombre?"}]}
    ]
}


def _published_survey(c):
    sv = c.post("/api/v1/survey/surveys", json={"title": "E", "json_schema": SCHEMA}).json()
    c.post(f"/api/v1/survey/surveys/{sv['id']}/publish")
    return sv


def test_delete_is_soft_and_hides_survey():
    c = new_client()
    register(c)
    sv = _published_survey(c)

    assert c.delete(f"/api/v1/survey/surveys/{sv['id']}").status_code == 204

    # Ya no se lista…
    listed = c.get("/api/v1/survey/surveys").json()
    assert all(x["id"] != sv["id"] for x in listed)
    # …ni se puede abrir/editar.
    assert c.get(f"/api/v1/survey/surveys/{sv['id']}").status_code == 404
    # …pero sigue en la papelera.
    trash = c.get("/api/v1/survey/surveys/trash/list").json()
    assert [x["id"] for x in trash] == [sv["id"]]
    assert trash[0]["deleted_at"] is not None


def test_deleted_survey_is_not_publicly_answerable():
    """Lo más importante: al mandarla a la papelera, el link público muere ya."""
    c = new_client()
    register(c)
    sv = _published_survey(c)
    slug = sv["slug"]

    # Antes de borrar, la encuesta se sirve públicamente.
    assert c.get(f"/api/v1/survey/public/{slug}").status_code == 200

    c.delete(f"/api/v1/survey/surveys/{sv['id']}")

    # Después, el link público es 404 y no se puede enviar una respuesta.
    assert c.get(f"/api/v1/survey/public/{slug}").status_code == 404
    r = c.post(f"/api/v1/survey/public/{slug}/submit", json={"answers": {"q1": "Ana"}})
    assert r.status_code == 404


def test_restore_brings_it_back_with_responses():
    c = new_client()
    register(c)
    sv = _published_survey(c)
    slug = sv["slug"]
    c.post(f"/api/v1/survey/public/{slug}/submit", json={"answers": {"q1": "Ana"}})

    c.delete(f"/api/v1/survey/surveys/{sv['id']}")
    r = c.post(f"/api/v1/survey/surveys/{sv['id']}/restore")
    assert r.status_code == 200

    # Vuelve al listado, se abre de nuevo, y la respuesta NO se perdió.
    listed = c.get("/api/v1/survey/surveys").json()
    assert any(x["id"] == sv["id"] for x in listed)
    assert c.get(f"/api/v1/survey/surveys/{sv['id']}").status_code == 200
    resps = c.get(f"/api/v1/survey/surveys/{sv['id']}/responses").json()
    assert len(resps) == 1
    # Y el link público revive.
    assert c.get(f"/api/v1/survey/public/{slug}").status_code == 200
    assert c.get("/api/v1/survey/surveys/trash/list").json() == []


def test_purge_requires_trash_first_and_is_permanent():
    c = new_client()
    register(c)
    sv = _published_survey(c)

    # No se puede purgar una encuesta viva: hay que mandarla a la papelera primero.
    assert c.delete(f"/api/v1/survey/surveys/{sv['id']}/purge").status_code == 409

    c.delete(f"/api/v1/survey/surveys/{sv['id']}")
    assert c.delete(f"/api/v1/survey/surveys/{sv['id']}/purge").status_code == 204

    # Ahora sí desapareció del todo: ni en la papelera ni restaurable.
    assert c.get("/api/v1/survey/surveys/trash/list").json() == []
    assert c.post(f"/api/v1/survey/surveys/{sv['id']}/restore").status_code == 404


def test_trash_is_isolated_per_org():
    """La papelera de una org no expone las encuestas borradas de otra."""
    a = new_client()
    register(a)
    sv = _published_survey(a)
    a.delete(f"/api/v1/survey/surveys/{sv['id']}")

    b = new_client()
    register(b)
    assert b.get("/api/v1/survey/surveys/trash/list").json() == []
    assert b.post(f"/api/v1/survey/surveys/{sv['id']}/restore").status_code == 404
    assert b.delete(f"/api/v1/survey/surveys/{sv['id']}/purge").status_code == 404
