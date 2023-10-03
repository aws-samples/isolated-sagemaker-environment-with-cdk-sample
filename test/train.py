import pandas as pd
import os
from sklearn.linear_model import LogisticRegression
import joblib

if __name__ == "__main__":
    df = pd.read_csv("/opt/ml/input/data/train/iris.csv")
    train_x = df.iloc[:, :-1].values
    train_y = df.iloc[:, -1].values

    model = LogisticRegression(max_iter=200)
    model.fit(train_x, train_y)

    model_dir = "/opt/ml/model"
    joblib.dump(model, os.path.join(model_dir, "model.pkl"))
