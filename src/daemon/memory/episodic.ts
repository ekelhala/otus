/**
 * SQLite Episodic Memory
 * Stores task history, command events, and reflections
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { WORKSPACE } from "@shared/constants.ts";

export interface Task {
  id: string;
  goal: string;
  status: "running" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
}

export interface Event {
  id: number;
  taskId: string;
  timestamp: number;
  type: "think" | "act" | "observe" | "reflect";
  data: Record<string, unknown>;
}

export interface Reflection {
  id: number;
  taskId: string;
  summary: string;
  lessons: string[];
  createdAt: number;
}

/**
 * Episodic Memory Manager
 */
export class EpisodicMemory {
  private db: Database;

  constructor(workspacePath: string) {
    const dbPath = join(workspacePath, WORKSPACE.OTUS_DIR, WORKSPACE.MEMORY_DB);
    this.db = new Database(dbPath);
    
    // Enable WAL mode for better concurrency
    this.db.run("PRAGMA journal_mode = WAL");
    
    this.initSchema();
  }

  /**
   * Initialize database schema
   */
  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT CHECK(status IN ('running', 'completed', 'failed')) NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        timestamp INTEGER NOT NULL,
        type TEXT CHECK(type IN ('think', 'act', 'observe', 'reflect')) NOT NULL,
        data TEXT NOT NULL
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_events_task_time 
      ON events(task_id, timestamp)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS reflections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        summary TEXT NOT NULL,
        lessons TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  /**
   * Create a new task
   */
  createTask(id: string, goal: string): Task {
    const task: Task = {
      id,
      goal,
      status: "running",
      createdAt: Date.now(),
    };

    const stmt = this.db.query(`
      INSERT INTO tasks (id, goal, status, created_at)
      VALUES ($id, $goal, $status, $createdAt)
    `);

    stmt.run({
      $id: task.id,
      $goal: task.goal,
      $status: task.status,
      $createdAt: task.createdAt,
    });

    return task;
  }

  /**
   * Update task status
   */
  updateTaskStatus(
    taskId: string,
    status: "running" | "completed" | "failed"
  ): void {
    const completedAt = status !== "running" ? Date.now() : null;

    const stmt = this.db.query(`
      UPDATE tasks 
      SET status = $status, completed_at = $completedAt
      WHERE id = $id
    `);

    stmt.run({
      $id: taskId,
      $status: status,
      $completedAt: completedAt,
    });
  }

  /**
   * Get a task by ID
   */
  getTask(taskId: string): Task | null {
    const stmt = this.db.query<Task, { $id: string }>(`
      SELECT 
        id,
        goal,
        status,
        created_at as createdAt,
        completed_at as completedAt
      FROM tasks
      WHERE id = $id
    `);

    return stmt.get({ $id: taskId }) || null;
  }

  /**
   * Log an event for a task
   */
  logEvent(
    taskId: string,
    type: "think" | "act" | "observe" | "reflect",
    data: Record<string, unknown>
  ): Event {
    const event: Omit<Event, "id"> = {
      taskId,
      timestamp: Date.now(),
      type,
      data,
    };

    const stmt = this.db.query(`
      INSERT INTO events (task_id, timestamp, type, data)
      VALUES ($taskId, $timestamp, $type, $data)
      RETURNING id
    `);

    const result = stmt.get({
      $taskId: event.taskId,
      $timestamp: event.timestamp,
      $type: event.type,
      $data: JSON.stringify(event.data),
    }) as { id: number };

    return { id: result.id, ...event };
  }

  /**
   * Get recent events for a task
   */
  getRecentEvents(taskId: string, limit = 10): Event[] {
    const stmt = this.db.query<
      { id: number; task_id: string; timestamp: number; type: string; data: string },
      { $taskId: string; $limit: number }
    >(`
      SELECT id, task_id, timestamp, type, data
      FROM events
      WHERE task_id = $taskId
      ORDER BY timestamp DESC
      LIMIT $limit
    `);

    const rows = stmt.all({ $taskId: taskId, $limit: limit });
    
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      timestamp: row.timestamp,
      type: row.type as Event["type"],
      data: JSON.parse(row.data),
    }));
  }

  /**
   * Get all events for a task
   */
  getTaskHistory(taskId: string): Event[] {
    const stmt = this.db.query<
      { id: number; task_id: string; timestamp: number; type: string; data: string },
      { $taskId: string }
    >(`
      SELECT id, task_id, timestamp, type, data
      FROM events
      WHERE task_id = $taskId
      ORDER BY timestamp ASC
    `);

    const rows = stmt.all({ $taskId: taskId });
    
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      timestamp: row.timestamp,
      type: row.type as Event["type"],
      data: JSON.parse(row.data),
    }));
  }

  /**
   * Save a reflection for a task
   */
  saveReflection(
    taskId: string,
    summary: string,
    lessons: string[]
  ): Reflection {
    const reflection: Omit<Reflection, "id"> = {
      taskId,
      summary,
      lessons,
      createdAt: Date.now(),
    };

    const stmt = this.db.query(`
      INSERT INTO reflections (task_id, summary, lessons, created_at)
      VALUES ($taskId, $summary, $lessons, $createdAt)
      RETURNING id
    `);

    const result = stmt.get({
      $taskId: reflection.taskId,
      $summary: reflection.summary,
      $lessons: JSON.stringify(reflection.lessons),
      $createdAt: reflection.createdAt,
    }) as { id: number };

    return { id: result.id, ...reflection };
  }

  /**
   * Get reflections for a task
   */
  getReflections(taskId: string): Reflection[] {
    const stmt = this.db.query<
      { id: number; task_id: string; summary: string; lessons: string; created_at: number },
      { $taskId: string }
    >(`
      SELECT id, task_id, summary, lessons, created_at
      FROM reflections
      WHERE task_id = $taskId
      ORDER BY created_at DESC
    `);

    const rows = stmt.all({ $taskId: taskId });
    
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      summary: row.summary,
      lessons: JSON.parse(row.lessons),
      createdAt: row.created_at,
    }));
  }

  /**
   * Search events by type
   */
  searchEvents(
    taskId: string,
    type: Event["type"],
    limit = 10
  ): Event[] {
    const stmt = this.db.query<
      { id: number; task_id: string; timestamp: number; type: string; data: string },
      { $taskId: string; $type: string; $limit: number }
    >(`
      SELECT id, task_id, timestamp, type, data
      FROM events
      WHERE task_id = $taskId AND type = $type
      ORDER BY timestamp DESC
      LIMIT $limit
    `);

    const rows = stmt.all({ $taskId: taskId, $type: type, $limit: limit });
    
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      timestamp: row.timestamp,
      type: row.type as Event["type"],
      data: JSON.parse(row.data),
    }));
  }

  /**
   * Close the database
   */
  close(): void {
    this.db.close();
  }
}
