async function sendPreset(message) {
  await fetch('/api/announcements', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: "Update",
      body: message
    })
  });

  alert("Sent: " + message);
}

async function send() {
  const text = document.getElementById('announcementInput').value;

  await fetch('/api/announcements', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: "Update",
      body: text
    })
  });

  alert("Announcement sent");
}

function preview() {
  const text = document.getElementById('announcementInput').value;
  document.getElementById('previewBox').innerText = text;
}

function handleAICommand() {
  const input = document.getElementById('aiInput').value;
  alert("AI will handle: " + input);
}
