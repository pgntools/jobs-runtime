# @pgntools/jobs-runtime — working notes

- The public surface is frozen by the v0.1 contract (CTA-216, amended in 0.3.0 by JBR-3):
  `src/contract.ts` holds it and `test/contract.test.ts` pins every export of every entry point
  against the verbatim copy in `test/contract/spec.ts`. Never add an export; a contract change is a change to CTA-216 first.
- XState stays internal: no XState type or actor in the public surface.
- Durable truth is the store; every durable change goes through `writeRecord` (normaliser +
  compare-and-set) with a transform from `src/core/records.ts`, whose status/phase moves go through
  the job machine (`src/core/jobMachine.ts`).
- No side effect at import, anywhere — `test/sideEffects.test.ts` enforces it.
- Design: ARCHITECTURE.md. Node 22 (`.nvmrc`).

## Commands

- Run one test: `npx vitest run test/<file>.test.ts -t "<test name>"`
- Run the full suite: `npm test` (with the 90 % coverage gate: `npm run test:coverage`)
- Also before committing: `npm run lint && npm run typecheck && npm run build`
