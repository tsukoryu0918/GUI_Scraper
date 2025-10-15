# -*- coding: utf-8 -*-
import os, sys, json, csv, smtplib
from pathlib import Path
from datetime import date
from email.message import EmailMessage

HERE = Path(__file__).resolve().parent

def load_config():
    p = HERE / "mail_config.json"
    if not p.exists():
        raise RuntimeError("mail_config.json が見つかりません: " + str(p))
    with p.open("r", encoding="utf-8") as rf:
        cfg = json.load(rf)
    # 必須ざっくりチェック
    for k in ["smtp", "auth", "from", "to"]:
        if k not in cfg:
            raise RuntimeError(f"mail_config.json に '{k}' がありません")
    if not cfg["to"]:
        raise RuntimeError("宛先(to) が空です")
    return cfg

def render_template(tpl: str, ctx: dict) -> str:
    out = tpl
    for k, v in ctx.items():
        out = out.replace("{" + k + "}", str(v))
    return out

def count_rows(csv_path: Path) -> int:
    try:
        with csv_path.open("r", encoding="utf-8-sig", newline="") as rf:
            r = csv.reader(rf)
            rows = list(r)
            if not rows:
                return 0
            # 先頭をヘッダーとみなす
            return max(0, len(rows) - 1)
    except Exception:
        return 0

def build_message(cfg: dict, subject: str, body: str, attach_paths):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"{cfg['from'].get('name','')} <{cfg['from'].get('email','')}>".strip()
    msg["To"]   = ", ".join(cfg.get("to", []))
    if cfg.get("cc"):
        msg["Cc"] = ", ".join(cfg.get("cc", []))
    if cfg.get("bcc"):
        msg["Bcc"] = ", ".join(cfg.get("bcc", []))
    msg.set_content(body)

    if cfg.get("attach", True):
        for p in attach_paths:
            path = Path(p)
            if not path.exists():
                continue
            data = path.read_bytes()
            msg.add_attachment(
                data,
                maintype="text",
                subtype="csv",
                filename=path.name
            )
    return msg

def send_mail(cfg: dict, msg: EmailMessage):
    host = cfg["smtp"].get("host","")
    port = int(cfg["smtp"].get("port", 465))
    sec  = (cfg["smtp"].get("security","ssl") or "ssl").lower()

    user = cfg["auth"].get("user","")
    pw   = cfg["auth"].get("password","")

    if sec == "ssl":
        with smtplib.SMTP_SSL(host, port) as smtp:
            if user:
                smtp.login(user, pw)
            smtp.send_message(msg)
    elif sec == "starttls":
        with smtplib.SMTP(host, port) as smtp:
            smtp.ehlo()
            smtp.starttls()
            smtp.ehlo()
            if user:
                smtp.login(user, pw)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(host, port) as smtp:
            if user:
                smtp.login(user, pw)
            smtp.send_message(msg)

if __name__ == "__main__":
    # 引数: pc_id list_name [file1 file2 ...]
    if len(sys.argv) < 3:
        print("使い方: python send.py <pc_id> <list_name> [添付ファイル...]")
        sys.exit(1)

    pc_id     = sys.argv[1]
    list_name = sys.argv[2]
    files     = sys.argv[3:]

    cfg = load_config()

    # 件数は先頭の添付から推定（無ければ 0）
    count = 0
    if files:
        count = count_rows(Path(files[0]))

    today = date.today().strftime("%Y%m%d")
    ctx = {
        "date": today,
        "pc_id": pc_id,
        "list_name": list_name,
        "count": count,
        "paths": "\n".join(files)
    }

    subject_tpl = cfg.get("subject_template", "【取得報告】{list_name}_{date}")
    body_tpl    = cfg.get("body_template", "{list_name}の取得が完了しました({pc_id})}")
    subject = render_template(subject_tpl, ctx)
    body    = render_template(body_tpl, ctx)

    try:
        msg = build_message(cfg, subject, body, files)
        send_mail(cfg, msg)
        print("メール送信しました")
        sys.exit(0)
    except Exception as e:
        # 今回の方針：fail_notify は既定OFF。エラー時は送らず終了。
        print("メール送信エラー:", e)
        sys.exit(1)
