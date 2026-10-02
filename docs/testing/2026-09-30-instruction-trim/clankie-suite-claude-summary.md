### clankie · claude 2.1.285 (Claude Code) · claude-sonnet-5-5

| Arm     | Pass rate    | 95% CI      | Tokens/trial (95% CI) | Wall/trial (95% CI) | Trials | Errors |
| ------- | ------------ | ----------- | --------------------- | ------------------- | ------ | ------ |
| current | 10/10 (100%) | 72% to 100% | 50k (41k to 58k)      | 7 s (5 s to 9 s)    | 10     | 0      |
| trimmed | 10/10 (100%) | 72% to 100% | 31k (23k to 40k)      | 7 s (5 s to 10 s)   | 10     | 0      |

trimmed − current, paired by case (case-clustered bootstrap):

| Measure             | Difference | 95% CI       | Verdict                  |
| ------------------- | ---------- | ------------ | ------------------------ |
| Pass rate           | +0%        | +0% to +0%   | within noise (10 cases)  |
| Pass rate: incident | +0%        | +0% to +0%   | within noise (5 cases)   |
| Pass rate: social   | +0%        | +0% to +0%   | within noise (5 cases)   |
| Tokens/trial        | −19k       | −23k to −14k | outside noise (10 cases) |
| Wall/trial          | +0 s       | −1 s to +1 s | within noise (10 cases)  |
