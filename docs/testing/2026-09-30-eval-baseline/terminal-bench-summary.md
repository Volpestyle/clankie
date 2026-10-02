### terminal-bench/terminal-bench-2-1 · claude 2.1.285 · claude-sonnet-5-5

| Arm     | Pass rate   | 95% CI     | Tokens/trial (95% CI) | Wall/trial (95% CI) | Trials | Errors |
| ------- | ----------- | ---------- | --------------------- | ------------------- | ------ | ------ |
| bare    | 22/25 (88%) | 70% to 96% | 64k (54k to 75k)      | 35 s (26 s to 46 s) | 25     | 0      |
| current | 20/25 (80%) | 61% to 91% | 116k (96k to 138k)    | 38 s (28 s to 50 s) | 25     | 0      |

current − bare, paired by case (case-clustered bootstrap):

| Measure              | Difference | 95% CI        | Verdict                 |
| -------------------- | ---------- | ------------- | ----------------------- |
| Pass rate            | −8%        | −28% to +0%   | within noise (5 cases)  |
| Pass rate: benchmark | −8%        | −28% to +0%   | within noise (5 cases)  |
| Tokens/trial         | +52k       | +30k to +78k  | outside noise (5 cases) |
| Wall/trial           | +3 s       | −3 s to +10 s | within noise (5 cases)  |
