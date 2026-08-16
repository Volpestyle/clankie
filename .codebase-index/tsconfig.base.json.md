# tsconfig.base.json

Shared compiler options every package tsconfig
extends. ES2023 target, NodeNext module and
resolution, and maximum strictness: `strict` plus
noUncheckedIndexedAccess,
exactOptionalPropertyTypes,
useUnknownInCatchVariables, noImplicitOverride,
verbatimModuleSyntax, erasableSyntaxOnly (no
TS-only runtime syntax like enums), and
isolatedModules. allowImportingTsExtensions is on
— source imports use .ts extensions and packages
run via tsx rather than emitted JS.
