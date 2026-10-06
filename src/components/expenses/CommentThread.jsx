import { MessageSquare } from "lucide-react";
import { formatDate, initials } from "../../utils/format";

export function CommentThread({ comment, onReply }) {
  return (
    <article className="comment">
      <div className="comment-heading">
        <span className="avatar small">{initials(comment.userName)}</span>
        <div>
          <strong>{comment.userName}</strong>
          <small>{comment.role}</small>
        </div>
        <time>{formatDate(comment.createdAt)}</time>
      </div>
      <p>{comment.message}</p>
      <button className="text-button" onClick={() => onReply(comment)}>
        <MessageSquare size={13} />
        Reply
      </button>
      {comment.replies.map((reply) => (
        <div key={reply.id} className="reply">
          <CommentThread comment={reply} onReply={onReply} />
        </div>
      ))}
    </article>
  );
}
