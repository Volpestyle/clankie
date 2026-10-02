### clankie · claude 2.1.285 (Claude Code) · claude-sonnet-5-5

| Arm     | Pass rate    | 95% CI      | Tokens/trial (95% CI) | Wall/trial (95% CI) | Trials | Errors |
| ------- | ------------ | ----------- | --------------------- | ------------------- | ------ | ------ |
| bare    | 75/80 (94%)  | 86% to 97%  | 24k (22k to 26k)      | 8 s (7 s to 9 s)    | 80     | 0      |
| current | 80/80 (100%) | 95% to 100% | 51k (47k to 55k)      | 8 s (7 s to 9 s)    | 80     | 0      |

current − bare, paired by case (case-clustered bootstrap):

| Measure             | Difference | 95% CI       | Verdict                  |
| ------------------- | ---------- | ------------ | ------------------------ |
| Pass rate           | +6%        | +0% to +19%  | within noise (16 cases)  |
| Pass rate: heldout  | +0%        | +0% to +0%   | within noise (5 cases)   |
| Pass rate: incident | +0%        | +0% to +0%   | within noise (5 cases)   |
| Pass rate: social   | +17%       | +0% to +50%  | within noise (6 cases)   |
| Tokens/trial        | +27k       | +22k to +33k | outside noise (16 cases) |
| Wall/trial          | −0 s       | −1 s to +1 s | within noise (16 cases)  |
