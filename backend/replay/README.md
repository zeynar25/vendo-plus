# Replay data

`sales_hopper_use.csv` is the grams each of the 3,636 sales took from the coffee,
milk, and chocolate hoppers (1 March 2024 to 23 March 2025). It is
`ml/data/processed/transaction_consumption.csv` with only the time and gram
columns kept, produced by `ml/consumption.py` with recipe R2 (2026-11-17)
from the Kaggle Coffee Sales file `index_1.csv`
(SHA-256 2a600445a1836da436a3e890e1e1cce0ecf279d369d3a9e280db3ea0d06b594e).

The grams are simulation inputs from the recipe table, not measured ingredient
use. Replay mode turns them into hopper readings so the model can be
demonstrated; it is labeled as replay everywhere it appears.

File SHA-256: 844e07fc39d056fcba638705174c8269919f579cc37fd8c622a151f1979a68e0
(source file SHA-256 f6507e577de820e6037b8bd04bf888a08bcd8d300d4c149856b9bd8e21ba6f30).
To rebuild it after changing the recipe, run the pipeline in `ml/` and keep the
columns `datetime, coffee_g, milk_g, chocolate_g`.
