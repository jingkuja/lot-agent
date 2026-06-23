import { useEffect, useRef, useState } from "react";
import { api, type TaskStatus } from "../api/client.js";

interface TaskProgressProps {
  jobId: string;
}

const POLL_INTERVAL_MS = 800;

export function TaskProgress({ jobId }: TaskProgressProps) {
  const [task, setTask] = useState<TaskStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const status = await api.getTask(jobId);
        if (!active) return;
        setTask(status);
        if (status.status === "done" || status.status === "failed") {
          if (timerRef.current) clearInterval(timerRef.current);
        }
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "获取任务失败");
        if (timerRef.current) clearInterval(timerRef.current);
      }
    };

    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      active = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [jobId]);

  if (error) {
    return <div className="task-progress task-progress--error">任务错误: {error}</div>;
  }

  if (!task) {
    return <div className="task-progress">加载任务中...</div>;
  }

  const isTerminal = task.status === "done" || task.status === "failed";
  const progress = Math.min(100, Math.max(0, task.progress ?? 0));

  return (
    <div className={`task-progress task-progress--${task.status}`}>
      <div className="task-progress-label">
        {task.status === "pending" && "等待中..."}
        {task.status === "running" && `处理中 ${progress}%`}
        {task.status === "done" && "完成"}
        {task.status === "failed" && `失败: ${task.error ?? ""}`}
      </div>
      {!isTerminal && (
        <div className="task-progress-bar">
          <div
            className="task-progress-bar-fill"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
      {task.status === "done" && task.output?.url && (
        <a
          className="task-progress-link"
          href={task.output.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          查看结果
        </a>
      )}
    </div>
  );
}
