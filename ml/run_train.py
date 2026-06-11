import subprocess

pairs = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"]
python_bin = r".venv\Scripts\python.exe"

for pair in pairs:
    print(f"=== Processing {pair} ===")
    
    # 1. Export Data
    cmd_export = [python_bin, "export_data.py", "--pair", pair, "--interval", "15m", "--limit", "2000"]
    print("Running:", " ".join(cmd_export))
    subprocess.run(cmd_export, check=True)
    
    # 2. Train XGBoost
    cmd_xg = [python_bin, "train.py", "--pair", pair, "--interval", "15m", "--model", "xgboost"]
    print("Running:", " ".join(cmd_xg))
    subprocess.run(cmd_xg, check=True)
    
    # 3. Train LightGBM
    cmd_lg = [python_bin, "train.py", "--pair", pair, "--interval", "15m", "--model", "lightgbm"]
    print("Running:", " ".join(cmd_lg))
    subprocess.run(cmd_lg, check=True)

print("=== ALL PAIRS COMPLETED SUCCESSFULLY ===")
