# Cursor templates

ไฟล์ในโฟลเดอร์นี้เป็น **template** สำหรับติดตั้งลง `.cursor/` ที่ root ของโปรเจกต์บนเครื่องแต่ละคน — ไม่ commit `.cursor/` จากเครื่องใครเครื่องหนึ่งเข้า repo

## ติดตั้งอัตโนมัติ (แนะนำ)

จาก root ของ repo ที่มี `ai-dev-office/`:

```bash
./ai-dev-office/scripts/install-cursor-templates.sh
```

ตัวเลือก:

| Flag | ความหมาย |
|------|----------|
| `--target <path>` | โฟลเดอร์ root ของโปรเจกต์ (ค่าเริ่มต้น: parent ของ `ai-dev-office/`) |
| `--force` | เขียนทับไฟล์ใน `.cursor/` ที่มีอยู่แล้ว |

สคริปต์จะแทนที่ `__REPO_ROOT__` ใน `rules/socraticode.mdc` ด้วย path จริงของ repo

## ติดตั้งมือ

```bash
mkdir -p .cursor/rules .cursor/agents
cp ai-dev-office/templates/cursor/rules/* .cursor/rules/
cp ai-dev-office/templates/cursor/agents/* .cursor/agents/
```

จากนั้นแก้ `__REPO_ROOT__` ใน `.cursor/rules/socraticode.mdc` ให้เป็น path ที่ clone repo ไว้บนเครื่องคุณ

## สิ่งที่ต้องตั้งบนเครื่องเอง (ไม่ copy จาก template)

- `~/.cursor/mcp.json` — config MCP / SocratiCode ระดับ user
- Docker stack สำหรับ local SocratiCode (ถ้าใช้) — ดู `ai-dev-office/docs/socraticode.md`

## โครงสร้าง

```text
templates/cursor/
├── rules/          → .cursor/rules/     (Cursor rules, รวม alwaysApply)
├── agents/         → .cursor/agents/    (subagent stubs → ai-dev-office/agents/*.md)
└── README.md
```

Bootstrap โปรเจกต์ใหม่จะเรียก install script ให้อัตโนมัติ: `scripts/bootstrap-project.sh`
