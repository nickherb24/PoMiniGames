// mixin.js — prototype composition for BrawlGame.
//
// Each subsystem (personality/super, VFX, the KO sequence + camera) is an ordinary
// class whose prototype is mixed into BrawlGame's, because its methods reach across
// ~40 fields of shared match state through `this`.
//
// getOwnPropertyDescriptors rather than Object.assign: class methods are
// NON-enumerable, so Object.assign copies nothing at all from a class prototype.
// Copying descriptors also preserves that non-enumerability, so the mixed-in
// methods behave identically to BrawlGame's own under for-in and JSON walks.

/**
 * Copy every method from each source prototype onto `target`.
 * @param {object} target  usually SomeClass.prototype
 * @param {...object} sources  prototypes produced by the subsystem modules
 */
export function mixin(target, ...sources) {
  for (const src of sources) {
    const descriptors = Object.getOwnPropertyDescriptors(src);
    // Every class prototype carries its own `constructor`; copying it would
    // repoint BrawlGame.prototype.constructor at the subsystem shell.
    delete descriptors.constructor;
    Object.defineProperties(target, descriptors);
  }
}
