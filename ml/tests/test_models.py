"""
Tests for train.py (step 7) and evaluate.py (step 8): selection rules,
baseline rules and metrics. These use small made-up inputs and never touch
the test partition.

Run from the project folder:
    python -m pytest -v
"""

import json
import pickle

import numpy as np
import pytest
from sklearn.linear_model import LogisticRegression

import config
import evaluate
import train


def row(algorithm, params, macro_f1, high_recall, high_precision, within_size_limit=True):
    return {"algorithm": algorithm, "params": params, "macro_f1": macro_f1,
            "high_recall": high_recall, "high_precision": high_precision,
            "within_size_limit": within_size_limit}


# ---- Selection rules (D-11, D-12) ------------------------------------------------

def test_highest_macro_f1_wins():
    rows = [row("random_forest", {"n_estimators": 100, "max_depth": 8, "min_samples_leaf": 5}, 0.70, 0.9, 0.4),
            row("random_forest", {"n_estimators": 200, "max_depth": 16, "min_samples_leaf": 20}, 0.71, 0.5, 0.3)]
    assert train.choose_best_configuration(rows)["macro_f1"] == 0.71


def test_tie_broken_by_high_recall_then_precision_then_size():
    rf = "random_forest"
    small = {"n_estimators": 100, "max_depth": 8, "min_samples_leaf": 20}
    big = {"n_estimators": 200, "max_depth": 16, "min_samples_leaf": 5}
    assert train.choose_best_configuration([row(rf, big, 0.7, 0.8, 0.4), row(rf, small, 0.7, 0.9, 0.4)])["params"] == small
    assert train.choose_best_configuration([row(rf, small, 0.7, 0.9, 0.3), row(rf, big, 0.7, 0.9, 0.4)])["params"] == big
    assert train.choose_best_configuration([row(rf, big, 0.7, 0.9, 0.4), row(rf, small, 0.7, 0.9, 0.4)])["params"] == small


def test_smaller_model_definitions():
    assert train.size_key("logistic_regression", {"C": 0.1}) < train.size_key("logistic_regression", {"C": 10})
    assert train.size_key("hist_gradient_boosting", {"max_leaf_nodes": 15}) < \
        train.size_key("hist_gradient_boosting", {"max_leaf_nodes": 31})
    # Fewer trees first, then shallower, then LARGER leaf size.
    assert train.size_key("random_forest", {"n_estimators": 100, "max_depth": 16, "min_samples_leaf": 5}) < \
        train.size_key("random_forest", {"n_estimators": 200, "max_depth": 8, "min_samples_leaf": 20})
    assert train.size_key("random_forest", {"n_estimators": 100, "max_depth": 8, "min_samples_leaf": 20}) < \
        train.size_key("random_forest", {"n_estimators": 100, "max_depth": 8, "min_samples_leaf": 5})


def test_final_model_prefers_meeting_both_targets():
    meets = row("logistic_regression", {"C": 1}, 0.81, 0.92, 0.5)
    higher_f1_but_low_recall = row("random_forest", {}, 0.85, 0.70, 0.6)
    assert train.choose_final_model([higher_f1_but_low_recall, meets]) is meets
    # If none meets both targets, the highest macro F1 wins.
    a, b = row("logistic_regression", {"C": 1}, 0.70, 0.8, 0.4), row("random_forest", {}, 0.72, 0.7, 0.4)
    assert train.choose_final_model([a, b]) is b


# ---- Grids and the size limit (D-39, D-40) -----------------------------------------

def test_grids_have_67_configurations_and_numeric_depths():
    assert len(config.LOGISTIC_REGRESSION_GRID) == 9
    assert len(config.RANDOM_FOREST_GRID) == 48
    assert len(config.HIST_GRADIENT_BOOSTING_GRID) == 10
    # None (unlimited depth) cannot be compared by the size tie-breaker.
    assert all(isinstance(p["max_depth"], int) for p in config.RANDOM_FOREST_GRID)
    grids = [config.LOGISTIC_REGRESSION_GRID, config.RANDOM_FOREST_GRID, config.HIST_GRADIENT_BOOSTING_GRID]
    assert all(len({str(p) for p in g}) == len(g) for g in grids)  # no duplicates


def test_learning_rate_comes_from_the_grid_with_the_old_default():
    assert train.make_model("hist_gradient_boosting", {"max_leaf_nodes": 15}).learning_rate == 0.05
    assert train.make_model("hist_gradient_boosting", {"max_leaf_nodes": 15, "learning_rate": 0.1}).learning_rate == 0.1


def test_model_size_is_the_serialized_size():
    model = LogisticRegression().fit([[0.0], [1.0], [2.0], [3.0]], [0, 0, 1, 1])
    expected = len(pickle.dumps(model, protocol=pickle.HIGHEST_PROTOCOL)) / 1e6
    assert train.model_size_mb(model) == pytest.approx(expected)


def test_a_configuration_over_the_size_limit_is_never_kept():
    rf = "random_forest"
    small = row(rf, {"n_estimators": 100, "max_depth": 8, "min_samples_leaf": 20}, 0.70, 0.8, 0.4)
    big_but_better = row(rf, {"n_estimators": 400, "max_depth": 32, "min_samples_leaf": 5}, 0.75, 0.9, 0.5,
                         within_size_limit=False)
    assert train.is_better(small, None)
    assert not train.is_better(big_but_better, None)
    assert not train.is_better(big_but_better, small)
    assert train.is_better(row(rf, small["params"], 0.71, 0.8, 0.4), small)


def test_size_limit_setting():
    assert config.MAX_MODEL_MB == 80.0


# ---- Baselines --------------------------------------------------------------------

def test_stock_only_baseline_thresholds_in_grams():
    assert evaluate.stock_only_baseline([49.9, 50.0, 50.1, 200.0, 200.1]).tolist() == \
        ["High", "High", "Medium", "Medium", "Low"]


def test_consumption_baseline():
    # 40 g left at 10 g/h -> 4 h (High); 41 g -> 4.1 h (Medium); 240 g -> 24 h (Medium);
    # 241 g -> 24.1 h (Low); no use in the last 24 h -> Low.
    rate = 10 / config.HOPPER_CAPACITY_G  # 10 g per hour as a share of capacity
    stock = [40, 41, 240, 241, 10]
    rates = [rate, rate, rate, rate, 0.0]
    assert evaluate.consumption_baseline(stock, rates).tolist() == ["High", "Medium", "Medium", "Low", "Low"]


# ---- Metrics ----------------------------------------------------------------------

def test_metrics_by_hand():
    truth = ["Low", "Low", "Medium", "High", "High"]
    pred = ["Low", "Medium", "Medium", "High", "Low"]
    m = train.classification_metrics(truth, pred)
    assert m["accuracy"] == pytest.approx(3 / 5)
    assert m["high_recall"] == pytest.approx(1 / 2)
    assert m["high_precision"] == pytest.approx(1.0)
    assert m["confusion_matrix"] == [[1, 1, 0], [0, 1, 0], [1, 0, 1]]  # rows: true Low, Medium, High
    expected_macro = np.mean([2 * 0.5 * 0.5 / 1.0, 2 * 0.5 * 1 / 1.5, 2 * 1 * 0.5 / 1.5])
    assert m["macro_f1"] == pytest.approx(expected_macro, abs=1e-6)


# ---- Real selection file (skipped until train.py has run) --------------------------

@pytest.mark.skipif(not config.SELECTION_PATH.exists(), reason="Run train.py first.")
def test_real_selection_used_validation_only():
    with open(config.SELECTION_PATH, encoding="utf-8") as f:
        selection = json.load(f)
    assert selection["selected_using"].startswith("validation")
    assert set(selection["kept_per_algorithm"]) == {"logistic_regression", "random_forest", "hist_gradient_boosting"}
    assert selection["feature_columns_in_order"] == config.FEATURE_COLUMNS
    assert selection["final_model"] in selection["kept_per_algorithm"]
