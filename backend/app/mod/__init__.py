"""Lógica de `mod_encuestum`, la actividad nativa de Moodle (sin LTI).

Los endpoints viven en `app/routers/modapi.py`; acá va lo que no depende de
FastAPI: la forma canónica del `wwwroot` (`wwwroot.py`) y la verificación del
token de lanzamiento (`launch.py`).
"""
