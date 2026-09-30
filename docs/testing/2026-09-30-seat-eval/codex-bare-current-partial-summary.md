### clankie · codex codex-cli 0.159.1 · gpt-6-astra

| Arm     | Pass rate   | 95% CI     | Tokens/trial (95% CI) | Wall/trial (95% CI) | Trials | Errors |
| ------- | ----------- | ---------- | --------------------- | ------------------- | ------ | ------ |
| bare    | 14/53 (26%) | 16% to 40% | 113k (97k to 130k)    | 38 s (34 s to 43 s) | 53     | 0      |
| current | 15/53 (28%) | 18% to 42% | 116k (100k to 132k)   | 30 s (27 s to 34 s) | 53     | 0      |

current − bare, paired by case (case-clustered bootstrap):

| Measure             | Difference | 95% CI        | Verdict                  |
| ------------------- | ---------- | ------------- | ------------------------ |
| Pass rate           | +4%        | −29% to +36%  | within noise (11 cases)  |
| Pass rate: coverage | −12%       | −36% to +0%   | within noise (5 cases)   |
| Pass rate: seat     | +17%       | −33% to +67%  | within noise (6 cases)   |
| Tokens/trial        | +2k        | −32k to +36k  | within noise (11 cases)  |
| Wall/trial          | −8 s       | −16 s to −0 s | outside noise (11 cases) |
