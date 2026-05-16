## Description

Brief description of what this PR does and why.

Closes #(issue number)

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Refactor (no functional change, code improvement)
- [ ] Documentation update
- [ ] Breaking change (fix or feature that would cause existing functionality to change)

## Changes

-
-

## Testing Performed

- [ ] `npm run build` compiles without errors
- [ ] `npx tsc --noEmit` passes type checking
- [ ] CLI starts and basic commands work in simulation mode
- [ ] `npm run test` passes (if applicable)
- [ ] Tested the specific feature/fix described above

## Checklist

- [ ] Code follows the project's TypeScript strict mode conventions
- [ ] No `any` types introduced
- [ ] External numeric data guarded with `Number.isFinite()`
- [ ] No private keys, API keys, or secrets in the diff
- [ ] No hardcoded prices or synthetic market data
- [ ] Error messages are descriptive (not generic "Error occurred")
- [ ] Changes to safety-critical paths (trading, wallet, signing) were discussed in an issue first

## Notes

Any additional context for reviewers.
