# Coding Guide

Every coding agent (human or AI) working in this repository must follow these rules.

* Use two spaces instead of tab for indentation
* Function calls and definitions have spaces between arguments, but not before/after parenthesis

  Avoid this:
  ```ts
  obj.somefunc( 1, 2, 3 );
  ```
  Do this:
  ```ts
  obj.somefunc(1, 2, 3);
  ```

* Try to keep type definitions within function bodies and headers compact.
* Logic is covered by plain tsx test scripts run by `npm test` (no test framework; no UI/component tests). When you change tested logic (rig math, main-process core modules, stores), extend the matching suite; new tools add their own (see `docs/architecture.md` "Adding a tool").
* Prefer global error handling over wrapping every single call in try/catch statements (unless needed for specific contextual logic)
* Do not place large objects that cause deep reactive state by Vue (eg avoid reactive three.js objects, etc)
* No single line "if" conditionals or "for" statements; place a new line.

  Avoid this:
  ```ts
  if (something) return 10;
  for (let i=0; i<10; i++) total *= 2;
  ```
  Do this:
  ```ts
  if (something)
    return 10;
  for (let i=0; i<10; i++)
    total *= 2;
  ```

* Generalize any css styling where possible unless only needed by specific view components.
* Try to be generalist where reasonable.
