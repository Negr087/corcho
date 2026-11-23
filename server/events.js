const { EventEmitter } = require("events");

// Bus en memoria para avisar "cambio algo en el corcho de X" a quien este
// escuchando (las paginas abiertas, via /api/events). Lo dispara la capa de
// datos en cada escritura, venga de la web o del bot.
const bus = new EventEmitter();
bus.setMaxListeners(0);

function emitChange(owner) {
  if (owner) bus.emit("change", owner);
}

module.exports = { bus, emitChange };
