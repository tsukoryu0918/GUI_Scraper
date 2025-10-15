import smtplib
from datetime import date, datetime
from email.message import EmailMessage
import sys

def send_mail(list_name: str, pc_id: str, file_paths: None):
    
    sender_email = "stream.jimukyoku@gmail.com"
    recipient_email="webm-all@po.hikari.co.jp"
    app_password = "jmdb xssf pjgr yqls"

    today_date = date.today().strftime('%Y%m%d')
    subject = f"【取得報告】{list_name}_{today_date}"
    body = f"{list_name}の取得が完了しました({pc_id})"

    if file_paths:
        body += "\n\n出力ファイルパス:\n"
        for path in file_paths:
            body += f"- {path}\n"

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender_email
    msg["To"] = recipient_email
    msg.set_content(body)

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(sender_email, app_password)
        smtp.send_message(msg)


if __name__ == "__main__":

    pc_id = sys.argv[1]
    list_name = sys.argv[2]
    file_paths = sys.argv[3:]

    send_mail(list_name, pc_id, file_paths)
