local tern = require("tern")

-- A fresh window context is also available after plugin reloads.
tern.timer(0, function(cx)
    local prefix = "[Tern " .. tern.json.encode(cx:window_key()) .. "] "
    tern.chrome.window_title(function(win)
        return prefix .. win.space
    end)
end)
