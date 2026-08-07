/**
 * Ajustes globales de SurveyJS. Importar ANTES de crear cualquier `Model`.
 *
 * Por defecto SurveyJS trata la barra vertical como separador de la notación
 * abreviada `valor|etiqueta` ("arg|Argentina"). Eso rompía en silencio cualquier
 * opción que contuviera una barra: `ItemValue.setValue` parte la cadena por el
 * primer "|", así que la opción `A "||" y algo más` se guardaba como valor
 * `A "` y etiqueta `|"`. El texto original se perdía sin ningún aviso.
 *
 * Acá se desactiva ese atajo (la propia librería lo saltea si el separador está
 * vacío), así una barra es un carácter más. La contra: deja de funcionar la
 * notación abreviada si alguien la escribe a mano en el editor JSON avanzado —
 * ahí hay que usar la forma explícita `{ "value": "arg", "text": "Argentina" }`,
 * que es la que genera el editor visual de todos modos.
 */
import { settings } from "survey-core";

settings.itemValueSeparator = "";

export {};
