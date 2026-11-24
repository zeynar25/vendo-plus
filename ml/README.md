# Vendo+ ML pipeline

Predicts the restock urgency (Low / Medium / High) of a coffee vending
machine's three ingredient hoppers, using the Kaggle Coffee Sales dataset
(`index_1.csv`). Every step is a separate, tested script.

| Step                                     | Script                | Output (data/processed/ or results/)                    |
| ---------------------------------------- | --------------------- | ------------------------------------------------------- |
| 1 Cleaning                               | `preprocessing.py`    | `coffee_sales_cleaned.csv`                              |
| 2 Ingredient consumption                 | `consumption.py`      | `transaction_consumption.csv`, `hourly_consumption.csv` |
| 3 Hopper stock simulation                | `stock_simulation.py` | `stock_scenarios.csv`                                   |
| 4 Urgency labels                         | `labels.py`           | `labeled_scenarios.csv`                                 |
| 5 Features                               | `features.py`         | `features.csv`                                          |
| 6 Chronological split                    | `split.py`            | `ml_dataset.csv`                                        |
| 7 Training + selection (validation only) | `train.py`            | `validation_results.csv`, `selection.json`, `models/`   |
| 8 Baselines + single test evaluation     | `evaluate.py`         | `test_results.csv`, figures, `evaluation_report.json`   |

After step 7, `python search_report.py` writes `search_range.csv` and
`validation_sensitivity.png`: for each setting, the validation macro F1 at every
value tried, with the algorithm's other settings held at the kept configuration.
It reads validation results only.

Other files:

- `config.py`: all fixed settings, including the one recipe table.
- `pipeline_utils.py`: shared helpers.
- `check_versions.py`: checks the installed Python and package versions.
- `requirements.txt`: the project's pinned dependencies.
- `docs/decision_log.md`: every assumption, decision and verified finding.

## Requirements

- Python **3.12** or **3.13** (64-bit)
- Windows PowerShell

> **Note:** Python 3.14 is not currently supported by the project's pinned dependencies.

## Environment setup

### 1. Install Python

Download and install either Python 3.12 or Python 3.13 from the [official Python website](https://www.python.org/downloads/).

During installation, enable **Add Python to PATH**.

Verify the installation:

```powershell
py --list
```

### 2. Create a virtual environment

Open PowerShell in the `ml/` directory and run:

```powershell
py -3.13 -m venv .venv
```

If using Python 3.12 instead:

```powershell
py -3.12 -m venv .venv
```

### 3. Activate the virtual environment

```powershell
.\.venv\Scripts\Activate.ps1
```

If PowerShell blocks script execution, run the following, then activate the environment again:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

### 4. Install dependencies

With the virtual environment activated:

```powershell
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

### 5. Verify the environment

Check the installed versions:

```powershell
python check_versions.py
```

Run the tests:

```powershell
python -m pytest
```

## Run the pipeline

1. Copy the raw dataset into place (the raw CSV is never modified):

   ```powershell
   copy "C:\path\to\index_1.csv" data\raw\index_1.csv
   ```

2. Run all eight steps:

   ```powershell
   python run_pipeline.py
   ```

3. Run the tests with detailed output:

   ```powershell
   python -m pytest -v
   ```

The full pipeline now trains 67 configurations (D-39), so it takes longer than
the first 13-configuration run. Every fit prints its time.

## Deactivate the environment

When finished:

```powershell
deactivate
```

To work on the project again, activate the existing environment (step 3). There is no need to recreate it.

## Notes

- The `.venv/` directory is local to each developer's machine and **must not be committed to Git**.
- The project dependencies are defined in `requirements.txt`.
