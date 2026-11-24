# Deployed model

- `random_forest.joblib`: the Random Forest selected on the validation period
  from 67 configurations (400 trees, depth 16, leaf size 20), trained by
  `ml/train.py`. The file is 35.6 MB (compressed); uncompressed, the model is
  79.4 MB, under the 80 MB limit in `ml/config.py` (decisions D-39 and D-40 in
  `ml/docs/decision_log.md`). Loading it raised the backend's memory from
  166 MB to 337 MB (F-23).
- `selection.json`: the selection record written by `ml/train.py`, unchanged. It holds
  the model's SHA-256 hash, the feature order, the class labels, and the
  scikit-learn version used for training.

At startup the backend refuses to use the model if the file's hash, the
scikit-learn version, or the feature order does not match `selection.json`.
The service then still runs and shows the basic stock warning everywhere.

To deploy a retrained model, copy both files from `ml/results/` (the
`.joblib` named in `final_model`, and `selection.json`) and commit them together.
