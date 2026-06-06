package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

type Chat struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Model        string `json:"model"`
	SystemPrompt string `json:"system_prompt"`
	CreatedAt    int64  `json:"created_at"`
	UpdatedAt    int64  `json:"updated_at"`
	Deleted      bool   `json:"deleted"`
}

type Message struct {
	ID        string `json:"id"`
	ChatID    string `json:"chat_id"`
	Role      string `json:"role"`
	Content   string `json:"content"`
	Tokens    int    `json:"tokens"`
	Timestamp int64  `json:"timestamp"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
	Deleted   bool   `json:"deleted"`
}

type Artifact struct {
	ID        string `json:"id"`
	MessageID string `json:"message_id"`
	Type      string `json:"type"`
	Content   string `json:"content"`
	FilePath  string `json:"file_path"`
	Metadata  string `json:"metadata"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
	Deleted   bool   `json:"deleted"`
}

type SyncRequest struct {
	ClientID  string     `json:"client_id"`
	Chats     []Chat     `json:"chats"`
	Messages  []Message  `json:"messages"`
	Artifacts []Artifact `json:"artifacts"`
}

type SyncResponse struct {
	Chats     []Chat     `json:"chats"`
	Messages  []Message  `json:"messages"`
	Artifacts []Artifact `json:"artifacts"`
	Timestamp int64      `json:"timestamp"`
}

func HandleSyncGet(w http.ResponseWriter, r *http.Request) {
	sinceStr := r.URL.Query().Get("since")
	since, _ := strconv.ParseInt(sinceStr, 10, 64)

	resp := SyncResponse{
		Chats:     []Chat{},
		Messages:  []Message{},
		Artifacts: []Artifact{},
		Timestamp: time.Now().UnixMilli(),
	}

	rows, err := db.Query("SELECT id, title, model, system_prompt, created_at, updated_at, deleted FROM chats WHERE updated_at > ?", since)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var c Chat
			rows.Scan(&c.ID, &c.Title, &c.Model, &c.SystemPrompt, &c.CreatedAt, &c.UpdatedAt, &c.Deleted)
			resp.Chats = append(resp.Chats, c)
		}
	}

	rowsMsg, err := db.Query("SELECT id, chat_id, role, content, tokens, timestamp, created_at, updated_at, deleted FROM messages WHERE updated_at > ?", since)
	if err == nil {
		defer rowsMsg.Close()
		for rowsMsg.Next() {
			var m Message
			rowsMsg.Scan(&m.ID, &m.ChatID, &m.Role, &m.Content, &m.Tokens, &m.Timestamp, &m.CreatedAt, &m.UpdatedAt, &m.Deleted)
			resp.Messages = append(resp.Messages, m)
		}
	}

	rowsArt, err := db.Query("SELECT id, message_id, type, content, file_path, metadata, created_at, updated_at, deleted FROM artifacts WHERE updated_at > ?", since)
	if err == nil {
		defer rowsArt.Close()
		for rowsArt.Next() {
			var a Artifact
			rowsArt.Scan(&a.ID, &a.MessageID, &a.Type, &a.Content, &a.FilePath, &a.Metadata, &a.CreatedAt, &a.UpdatedAt, &a.Deleted)
			resp.Artifacts = append(resp.Artifacts, a)
		}
	}

	RespondJson(w, http.StatusOK, resp)
}

func HandleSyncPost(w http.ResponseWriter, r *http.Request) {
	var req SyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	tx, err := db.Begin()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	stmtChat, _ := tx.Prepare(`
		INSERT INTO chats (id, title, model, system_prompt, created_at, updated_at, deleted)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			title=excluded.title,
			model=excluded.model,
			system_prompt=excluded.system_prompt,
			created_at=excluded.created_at,
			updated_at=excluded.updated_at,
			deleted=excluded.deleted
		WHERE excluded.updated_at > chats.updated_at
	`)
	defer stmtChat.Close()
	for _, c := range req.Chats {
		stmtChat.Exec(c.ID, c.Title, c.Model, c.SystemPrompt, c.CreatedAt, c.UpdatedAt, c.Deleted)
	}

	stmtMsg, _ := tx.Prepare(`
		INSERT INTO messages (id, chat_id, role, content, tokens, timestamp, created_at, updated_at, deleted)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			chat_id=excluded.chat_id,
			role=excluded.role,
			content=excluded.content,
			tokens=excluded.tokens,
			timestamp=excluded.timestamp,
			created_at=excluded.created_at,
			updated_at=excluded.updated_at,
			deleted=excluded.deleted
		WHERE excluded.updated_at > messages.updated_at
	`)
	defer stmtMsg.Close()
	for _, m := range req.Messages {
		stmtMsg.Exec(m.ID, m.ChatID, m.Role, m.Content, m.Tokens, m.Timestamp, m.CreatedAt, m.UpdatedAt, m.Deleted)
	}

	stmtArt, _ := tx.Prepare(`
		INSERT INTO artifacts (id, message_id, type, content, file_path, metadata, created_at, updated_at, deleted)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			message_id=excluded.message_id,
			type=excluded.type,
			content=excluded.content,
			file_path=excluded.file_path,
			metadata=excluded.metadata,
			created_at=excluded.created_at,
			updated_at=excluded.updated_at,
			deleted=excluded.deleted
		WHERE excluded.updated_at > artifacts.updated_at
	`)
	defer stmtArt.Close()
	for _, a := range req.Artifacts {
		stmtArt.Exec(a.ID, a.MessageID, a.Type, a.Content, a.FilePath, a.Metadata, a.CreatedAt, a.UpdatedAt, a.Deleted)
	}

	if req.ClientID != "" {
		now := time.Now().UnixMilli()
		_, _ = tx.Exec(`
			INSERT INTO sync_log (client_id, last_sync) VALUES (?, ?)
			ON CONFLICT(client_id) DO UPDATE SET last_sync=excluded.last_sync
		`, req.ClientID, now)
	}

	if err := tx.Commit(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	RespondJson(w, http.StatusOK, map[string]any{"status": "ok"})
}
