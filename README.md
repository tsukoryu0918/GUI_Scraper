# GUI_Scraper
ノーコードでスクレイピングを拡張機能で実現しよう

ノーコーで行ったものをコードとして出力したい

Xpathの出力方法
getUniqueXPath：

クリック要素の 絶対XPath を生成（id が綺麗なら //*[@id='...'] を優先）

id がなければ /tag[index] を親へ遡りながら積む

buildHeaderLinkedXPath（超重要）：

表の td をクリックしたとき、同じ行の th テキスト（項目名）で紐づくXPathを作る

//table[クラス条件]//tr[.//th[normalize-space(.)='代表者']] / td[1] のような「ヘッダ名で位置を固定」するXPathになるため、ラベル変更がなければDOM構造が多少動いても耐性が高い。


そもそもどんなものを作成しようとしているのか、前のチャットからどんなことを引き継いだのか、このチャットでは何をやったのか、現在抱えてる課題をまとめて次のチャットに引き継ぐためのプロンプトをメモ形式で書いて。

出力したPythonコードの動かし方：
1.Requirements: pip install playwright lxml pandas
2.Setup: python -m playwright install
上記は初めだけ
3.python gui_scraper_runner.py input.csv output.csv

実験履歴
福井ジョブチャンネル：〇
ジョブワーク滋賀：〇
あのこの愛媛：〇

ミニビルダー大きすぎて閉じるボタン押せないので次回はUI改善から
url取得する際にもcsv読み込めるようにしたい。各県ごとに一覧ページが分かれている場合に対応できるように
