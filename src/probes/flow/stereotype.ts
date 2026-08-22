/**
 * One definition of "the subject declares this type a Spring component", shared
 * by the Flow producer and the Flow gate.
 *
 * The producer reads annotation nodes off a parse tree (`symbols.ts`); the gate
 * matches annotation text in the pinned blob (`src/gate/flow.ts`). Those two
 * derivations are deliberately INDEPENDENT - that is what makes the gate a check
 * rather than an echo. But they must agree on WHICH annotations name a bean, or
 * a set the producer considers container-managed is one the gate reports as
 * unmanaged and contradicts - a real closed-set arrow quarantined purely because
 * the two sides kept different lists. So the list - the definition - lives here
 * and both sides import it, exactly as `route.ts` shares one definition of "the
 * same route" and `manifests.ts` shares one definition of "declared". The
 * RESOLUTION (how each side reads it) stays split.
 *
 * `@Bean` factory methods are deliberately absent for the reason `symbols.ts`
 * records: the bean they produce is typed through a factory this reader cannot
 * follow, and a set that is partly declared and partly guessed is worse than one
 * that says what it read.
 */
export const SPRING_STEREOTYPES = [
  "Component",
  "Service",
  "Repository",
  "Controller",
  "RestController",
  "ControllerAdvice",
  "RestControllerAdvice",
  "Configuration",
];
