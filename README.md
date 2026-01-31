# NanoClaw

Personal Claude assistant via WhatsApp.

## Quick Start

```bash
git clone https://github.com/yourname/nanoclaw.git
cd nanoclaw
claude
# Run: /setup
```

Claude Code handles installation, authentication, and service setup.

## Features

- **WhatsApp I/O**: Message Claude from your phone
- **Persistent memory**: Per-group conversation context
- **Global memory**: Shared context across all groups
- **Email tools**: Read/send via Gmail (optional)
- **Scheduled tasks**: Recurring reminders and jobs
- **Web access**: Search and fetch content

## Usage

```
@Andy what's the weather in NYC?
@Andy summarize my unread emails
@Andy remind me every Monday at 9am to check metrics
/clear
```

From main channel:
```
@Andy add group "Family Chat"
@Andy list groups
```

## Requirements

- macOS (or Linux)
- Node.js 18+
- Claude Code CLI (authenticated)

## Manual Setup

```bash
npm install
npm run build
npm start
```

## Customization

Run Claude Code and ask to:
- "Change trigger to @Bot"
- "Make responses more concise"

Or use `/customize`.

## Architecture

Single Node.js process using:
- `@whiskeysockets/baileys` - WhatsApp Web API
- `@anthropic-ai/claude-agent-sdk` - Claude Agent SDK
- `better-sqlite3` - Message storage

## License

MIT
