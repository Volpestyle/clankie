### clankie · codex codex-cli 0.159.1 · gpt-6-astra

| Arm      | Pass rate    | 95% CI      | Tokens/trial (95% CI) | Wall/trial (95% CI) | Trials | Errors |
| -------- | ------------ | ----------- | --------------------- | ------------------- | ------ | ------ |
| pre-1456 | 48/48 (100%) | 93% to 100% | 64k (57k to 70k)      | 26 s (22 s to 30 s) | 48     | 0      |
| trimmed  | 48/48 (100%) | 93% to 100% | 47k (42k to 52k)      | 25 s (20 s to 29 s) | 48     | 0      |

trimmed − pre-1456, paired by case (case-clustered bootstrap):

| Measure             | Difference | 95% CI       | Verdict                  |
| ------------------- | ---------- | ------------ | ------------------------ |
| Pass rate           | +0%        | +0% to +0%   | within noise (16 cases)  |
| Pass rate: heldout  | +0%        | +0% to +0%   | within noise (5 cases)   |
| Pass rate: incident | +0%        | +0% to +0%   | within noise (5 cases)   |
| Pass rate: social   | +0%        | +0% to +0%   | within noise (6 cases)   |
| Tokens/trial        | −17k       | −27k to −11k | outside noise (16 cases) |
| Wall/trial          | −1 s       | −3 s to +1 s | within noise (16 cases)  |
