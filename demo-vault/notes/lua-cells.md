# Lua live cells

```lua-run
print('hello from Lua')
print('2 + 40 =', 2 + 40)
return 'The sandbox is running in a Web Worker.'
```

Cells share one VM per document, so later cells can reuse earlier variables.

```lua-run
local rows = {}
for i = 1, 4 do
  rows[#rows + 1] = { 'Row ' .. i, tostring(i * i), tostring(i ^ 3) }
end
return { table = { headers = { 'n', 'n squared', 'n cubed' }, rows = rows } }
```

Return a Markdown string to use the full preview pipeline (KaTeX included):

```lua-run
local total = 0
for i = 1, 10 do total = total + i end
return {
  markdown = '**Sum of 1..10** is $' .. total .. '$. '
    .. 'That is `n(n+1)/2`.'
}
```

The read-only vault bridge can list and read notes:

```lua-run
local files = vault.list('notes/')
local lines = { '### Notes reachable from Lua', '' }
for i, file in ipairs(files) do
  if i > 8 then
    lines[#lines + 1] = '- …and ' .. (#files - 8) .. ' more'
    break
  end
  lines[#lines + 1] = '- `' .. file.path .. '` (' .. file.size .. ' bytes)'
end
return { markdown = table.concat(lines, '\n') }
```

Structured data comes back as a collapsible JSON view:

```lua-run
return {
  json = {
    runtime = 'wasmoon (Lua 5.4)',
    cells = 5,
    sandbox = { dom = false, network = 'vault API only', timeoutMs = 5000 },
  },
}
```

Errors stay inside the output panel:

```lua-run
error('this is a handled Lua error')
```
