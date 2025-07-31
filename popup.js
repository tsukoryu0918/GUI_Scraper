document.getElementById("start-scraping").addEventListener("click", async () => {
  document.getElementById("status").innerText = "スクレイピング中...";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"],
  });
});
