# -*- coding: utf-8 -*-
import sys, os, datetime
import pandas as pd

def cleansing(df: pd.DataFrame) -> pd.DataFrame:
    # TODO: 必要なクレンジングがある場合はここで実装
    return df

def main():
    if len(sys.argv) != 4:
        print("使い方: python rename.py <pc_id> <list_name> <csvファイルパス>")
        sys.exit(1)

    pc_id = sys.argv[1]
    list_name = sys.argv[2]
    file_path = sys.argv[3]

    if not os.path.isfile(file_path):
        print(f"エラー: ファイルが見つかりません: {file_path}")
        sys.exit(1)

    today = datetime.datetime.now().strftime("%Y%m%d")

    try:
        df = pd.read_csv(file_path, encoding='utf-8-sig', encoding_errors='ignore',
                         engine='python', on_bad_lines='skip')
    except Exception as e:
        print(f"エラー: CSVの読み込みに失敗しました: {e}")
        sys.exit(1)

    df = cleansing(df)
    num = len(df)

    new_filename = f"{today}_{pc_id}_{list_name}_{num}件.csv"
    dir_name = os.path.dirname(file_path)
    new_path = os.path.join(dir_name, new_filename)

    try:
        df.to_csv(new_path, index=False, encoding='utf-8-sig')
        print(f"ファイルを保存しました: {new_filename}")
    except Exception as e:
        print(f"エラー: ファイルの保存中に問題が発生しました: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
