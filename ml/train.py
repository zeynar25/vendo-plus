"""
train.py - Pipeline step 7: model training and validation-based selection

Trains 67 model configurations on the TRAINING partition only and scores them
on the VALIDATION partition. The test partition is never loaded here.

  Logistic Regression          9 fits  (C = 0.0001 to 10,000, one per power of ten)
  Random Forest               48 fits  (trees 100/200/400 x depth 8/16/24/32
                                        x leaf 5/20/50/100)
  Histogram Gradient Boosting 10 fits  (max leaf nodes 7/15/31/63/127
                                        x learning rate 0.05/0.1)

Every model's uncompressed serialized size is measured. A configuration larger
than config.MAX_MODEL_MB is reported but cannot be kept (D-40).

For each algorithm the configuration with the highest validation macro F1 is
kept. Ties are broken by higher High recall, then higher High precision, then
the smaller model (D-11). Among the three kept models, those meeting both
targets (macro F1 >= 0.80, High recall >= 0.90) are preferred; if none does,
the highest validation macro F1 wins (D-12).

Only the best model so far of each algorithm is held in memory, so a large grid
does not hold dozens of forests at once.

Outputs:
  results/validation_results.csv   one row per configuration, with its size
  results/models/<algorithm>.joblib the three kept models
  results/selection.json           what was kept and why (read by evaluate.py)

How to run (from the project folder):
    python train.py
"""

import pickle
import time
import warnings
from datetime import datetime

import joblib
import pandas as pd
import sklearn
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, confusion_matrix, precision_recall_fscore_support
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

import config
from pipeline_utils import file_sha256, relative_path, save_csv, save_json, verify_input

ALGORITHMS = {
    "logistic_regression": config.LOGISTIC_REGRESSION_GRID,
    "random_forest": config.RANDOM_FOREST_GRID,
    "hist_gradient_boosting": config.HIST_GRADIENT_BOOSTING_GRID,
}


# =============================================================================
# Block 1. Data and models
# =============================================================================

def load_partitions(names, dataset_path=config.ML_DATASET_PATH, split_report_path=config.SPLIT_REPORT_PATH):
    """Read the dataset and return only the requested partitions."""
    verify_input(dataset_path, split_report_path, "dataset_file")
    data = pd.read_csv(dataset_path, parse_dates=["decision_time"])
    return {name: data[data["partition"] == name].reset_index(drop=True) for name in names}


def make_model(algorithm, params):
    """Build one untrained model with the fixed settings from the methodology."""
    if algorithm == "logistic_regression":
        # The scaler is part of the pipeline, so it learns means and SDs from
        # the training data only and reuses them on validation and test.
        # penalty is left at its default (L2), see the scikit-learn 1.8 note in D-14.
        return make_pipeline(StandardScaler(),
                             LogisticRegression(C=params["C"], class_weight="balanced", max_iter=2000))
    if algorithm == "random_forest":
        return RandomForestClassifier(n_estimators=params["n_estimators"], max_depth=params["max_depth"],
                                      min_samples_leaf=params["min_samples_leaf"], criterion="gini",
                                      bootstrap=True, max_features="sqrt",
                                      class_weight="balanced_subsample",
                                      random_state=config.RANDOM_SEED, n_jobs=-1)
    if algorithm == "hist_gradient_boosting":
        return HistGradientBoostingClassifier(learning_rate=params.get("learning_rate", 0.05), max_iter=200,
                                              min_samples_leaf=20,
                                              l2_regularization=1.0, max_leaf_nodes=params["max_leaf_nodes"],
                                              class_weight="balanced", early_stopping=False,
                                              random_state=config.RANDOM_SEED)
    raise ValueError(f"Unknown algorithm: {algorithm}")


# =============================================================================
# Block 2. Metrics (also used by evaluate.py)
# =============================================================================

def classification_metrics(y_true, y_pred):
    """Accuracy, macro F1, per-class precision/recall/F1 and the confusion matrix."""
    precision, recall, f1, support = precision_recall_fscore_support(
        y_true, y_pred, labels=config.LABELS, zero_division=0)
    metrics = {"accuracy": accuracy_score(y_true, y_pred), "macro_f1": f1.mean()}
    for k, label in enumerate(config.LABELS):
        name = label.lower()
        metrics[f"{name}_precision"] = precision[k]
        metrics[f"{name}_recall"] = recall[k]
        metrics[f"{name}_f1"] = f1[k]
        metrics[f"{name}_support"] = int(support[k])
    metrics = {k: (round(float(v), 6) if isinstance(v, float) or hasattr(v, "dtype") else v)
               for k, v in metrics.items()}
    # Rows = true label, columns = predicted label, both in the order Low, Medium, High.
    metrics["confusion_matrix"] = confusion_matrix(y_true, y_pred, labels=config.LABELS).tolist()
    return metrics


# =============================================================================
# Block 3. Selection rules
# =============================================================================

class _ByteCounter:
    """A write-only file that counts bytes instead of storing them."""

    def __init__(self):
        self.count = 0

    def write(self, data):
        size = memoryview(data).nbytes
        self.count += size
        return size


def model_size_mb(model):
    """Uncompressed serialized size in MB (10^6 bytes), used as the model's memory size (D-40).
    The bytes are counted as they are written, so a large forest is never copied in memory."""
    counter = _ByteCounter()
    pickle.dump(model, counter, protocol=pickle.HIGHEST_PROTOCOL)
    return counter.count / 1e6


def size_key(algorithm, params):
    """Smaller value = smaller model (D-11)."""
    if algorithm == "logistic_regression":
        return (params["C"],)
    if algorithm == "random_forest":
        return (params["n_estimators"], params["max_depth"], -params["min_samples_leaf"])
    return (params["max_leaf_nodes"],)


def selection_key(r):
    """Smaller is better: highest macro F1, then High recall, then High precision, then the smaller model."""
    return (-r["macro_f1"], -r["high_recall"], -r["high_precision"], size_key(r["algorithm"], r["params"]))


def choose_best_configuration(rows):
    """Highest macro F1, then High recall, then High precision, then the smaller model."""
    return min(rows, key=selection_key)


def is_better(candidate, current):
    """True if candidate should replace current as its algorithm's kept configuration.
    A configuration over the size limit is never kept (D-40)."""
    if not candidate["within_size_limit"]:
        return False
    return current is None or selection_key(candidate) < selection_key(current)


def meets_targets(row):
    return row["macro_f1"] >= config.TARGET_MACRO_F1 and row["high_recall"] >= config.TARGET_HIGH_RECALL


def choose_final_model(kept):
    """Prefer models meeting both targets; then highest macro F1, High recall, High precision (D-12)."""
    candidates = [r for r in kept if meets_targets(r)] or kept
    return min(candidates, key=lambda r: (-r["macro_f1"], -r["high_recall"], -r["high_precision"]))


# =============================================================================
# Block 4. Train, score on validation, keep the best of each algorithm
# =============================================================================

def run_training(dataset_path=config.ML_DATASET_PATH, split_report_path=config.SPLIT_REPORT_PATH,
                 results_path=config.VALIDATION_RESULTS_PATH, models_dir=config.MODELS_DIR,
                 selection_path=config.SELECTION_PATH, algorithms=None):
    algorithms = algorithms or ALGORITHMS
    parts = load_partitions(["train", "validation"], dataset_path, split_report_path)
    X_train, y_train = parts["train"][config.FEATURE_COLUMNS], parts["train"]["label"]
    X_val, y_val = parts["validation"][config.FEATURE_COLUMNS], parts["validation"]["label"]

    rows = []
    best = {algorithm: (None, None) for algorithm in algorithms}  # algorithm -> (row, model)
    for algorithm, grid in algorithms.items():
        for params in grid:
            model = make_model(algorithm, params)
            started = time.perf_counter()
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always", ConvergenceWarning)
                model.fit(X_train, y_train)
            seconds = time.perf_counter() - started
            metrics = classification_metrics(y_val, model.predict(X_val))
            size_mb = model_size_mb(model)
            row = {"algorithm": algorithm, "params": params, "fit_seconds": round(seconds, 1),
                   "converged": not any(issubclass(w.category, ConvergenceWarning) for w in caught),
                   "model_mb": round(size_mb, 1), "within_size_limit": size_mb <= config.MAX_MODEL_MB,
                   **metrics}
            rows.append(row)
            if is_better(row, best[algorithm][0]):
                best[algorithm] = (row, model)
            del model
            print(f"  {algorithm:24s} {str(params):70s} macro F1 {row['macro_f1']:.4f}  "
                  f"High recall {row['high_recall']:.4f}  {row['model_mb']:7.1f} MB"
                  f"{'' if row['within_size_limit'] else ' (over the size limit)'}  ({seconds:.0f} s)")

    missing = [algorithm for algorithm, (row, _) in best.items() if row is None]
    if missing:
        raise ValueError(f"No configuration within {config.MAX_MODEL_MB} MB for: {missing}")

    table = pd.DataFrame(rows)
    table["params"] = table["params"].astype(str)
    table["confusion_matrix"] = table["confusion_matrix"].astype(str)
    save_csv(table, results_path)

    models_dir.mkdir(parents=True, exist_ok=True)
    kept = {}
    for algorithm, (row, model) in best.items():
        model_path = models_dir / f"{algorithm}.joblib"
        joblib.dump(model, model_path, compress=3)
        kept[algorithm] = {**row, "meets_both_targets_on_validation": meets_targets(row),
                           "model_file": relative_path(model_path), "model_sha256": file_sha256(model_path)}

    final = choose_final_model(list(kept.values()))
    selection = {
        "selected_using": "validation partition only (test partition not loaded)",
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "scikit_learn_version": sklearn.__version__,
        "recipe_version": config.RECIPE_VERSION,
        "feature_columns_in_order": config.FEATURE_COLUMNS,
        "labels": config.LABELS,
        "targets": {"macro_f1": config.TARGET_MACRO_F1, "high_recall": config.TARGET_HIGH_RECALL},
        "max_model_mb": config.MAX_MODEL_MB,
        "configurations": len(rows),
        "configurations_within_size_limit": sum(r["within_size_limit"] for r in rows),
        "dataset_sha256": file_sha256(dataset_path),
        "training_rows": len(X_train),
        "validation_rows": len(X_val),
        "kept_per_algorithm": kept,
        "final_model": final["algorithm"],
        "final_model_reason": ("meets both targets on validation and has the highest validation macro F1 among those that do"
                               if meets_targets(final) else
                               "no kept model meets both targets on validation; highest validation macro F1"),
    }
    save_json(selection, selection_path)
    return selection


def main():
    total = sum(len(grid) for grid in ALGORITHMS.values())
    print(f"Training {total} configurations (training partition) and scoring them on validation:")
    selection = run_training()
    print("\nKept per algorithm (validation):")
    for algorithm, row in selection["kept_per_algorithm"].items():
        print(f"  {algorithm:24s} {str(row['params']):55s} macro F1 {row['macro_f1']:.4f}  "
              f"High recall {row['high_recall']:.4f}  targets met: {row['meets_both_targets_on_validation']}")
    print("Final model        :", selection["final_model"], "-", selection["final_model_reason"])
    print("Written            :", relative_path(config.VALIDATION_RESULTS_PATH), "and",
          relative_path(config.SELECTION_PATH))


if __name__ == "__main__":
    main()
