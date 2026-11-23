process.env.TZ = "America/Argentina/Buenos_Aires";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseReminderTime, detectReminderIntent } = require("../server/noteHeuristics");

// lunes 23/11/2026, 12:00
const NOW = new Date(2026, 10, 23, 12, 0, 0);

function at(y, mo, d, h, mi = 0) {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}
function parse(text) {
  const d = parseReminderTime(text, NOW);
  return d ? d.getTime() : null;
}

const cases = [
  // relativos
  ["en 2 horas", NOW.getTime() + 2 * 3600000],
  ["en dos horas", NOW.getTime() + 2 * 3600000],
  ["en 30 min", NOW.getTime() + 30 * 60000],
  ["en media hora", NOW.getTime() + 30 * 60000],
  ["en una hora y media", NOW.getTime() + 90 * 60000],
  ["en 1 dia", at(2026, 11, 24, 9)],
  ["en 3 dias a las 10", at(2026, 11, 26, 10)],
  ["en 2 semanas", at(2026, 12, 7, 9)],
  ["la semana que viene", at(2026, 11, 30, 9)],
  ["la proxima semana a las 18", at(2026, 11, 30, 18)],
  // dias
  ["mañana", at(2026, 11, 24, 9)],
  ["pasado mañana", at(2026, 11, 25, 9)],
  ["mañana a las 10", at(2026, 11, 24, 10)],
  ["mañana a las 10 de la mañana", at(2026, 11, 24, 10)],
  ["mañana a las 10 de la noche", at(2026, 11, 24, 22)],
  ["el lunes a las 9 de la mañana", at(2026, 11, 30, 9)],
  ["el viernes a las 12 de la noche", at(2026, 11, 28, 0)],
  // horas sin aclarar: 1 a 7 se toman de tarde
  ["mañana a las 3", at(2026, 11, 24, 15)],
  ["a la 1", at(2026, 11, 23, 13)],
  ["a las 7", at(2026, 11, 23, 19)],
  ["a las 8", at(2026, 11, 24, 8)],
  ["mañana a las 3 de la mañana", at(2026, 11, 24, 3)],
  ["mañana 07:30", at(2026, 11, 24, 7, 30)],
  // formatos de hora
  ["mañana 10hs", at(2026, 11, 24, 10)],
  ["mañana 10 hs", at(2026, 11, 24, 10)],
  ["mañana 10.30", at(2026, 11, 24, 10, 30)],
  ["hoy 18:45", at(2026, 11, 23, 18, 45)],
  ["mañana a las 10 y media", at(2026, 11, 24, 10, 30)],
  ["mañana tipo las 11", at(2026, 11, 24, 11)],
  // fechas
  ["25/12 20:00", at(2026, 12, 25, 20)],
  ["10/12 a las 9", at(2026, 12, 10, 9)],
  ["el 5/1", at(2027, 1, 5, 9)],
  ["el 5/1/2028", at(2028, 1, 5, 9)],
  // nada reconocible
  ["comprar pan", null],
];

for (const [text, expected] of cases) {
  test(`parseReminderTime: "${text}"`, () => {
    const got = parse(text);
    assert.equal(
      got,
      expected,
      `esperaba ${expected && new Date(expected).toString()}, dio ${got && new Date(got).toString()}`
    );
  });
}

test("detectReminderIntent solo dispara con un pedido explicito", () => {
  assert.equal(detectReminderIntent("reunion a las 10", NOW), null);
  assert.equal(detectReminderIntent("recordame mañana a las 10 llamar a Juan", NOW).getTime(), at(2026, 11, 24, 10));
  assert.equal(detectReminderIntent("avisame en 2 horas", NOW).getTime(), NOW.getTime() + 2 * 3600000);
});
