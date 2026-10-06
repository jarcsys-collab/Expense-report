import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { config } from "../config/appConfig";
import { api } from "../services/api";
import {
  GUEST_USER,
  loadSession,
  logout as endSession,
  setActiveUser,
} from "../services/authService";
import { createId } from "../utils/format";

export const WorkspaceContext = createContext(null);
export function WorkspaceProvider({ children }) {
  const [user, setUser] = useState(GUEST_USER);
  const [authenticated, setAuthenticated] = useState(false);
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pendingRequests, setPendingRequests] = useState(0);
  const loadId = useRef(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [toasts, setToasts] = useState([]);
  const notify = useCallback((message, isError = false) => {
    const toastId = createId();
    setToasts((current) => [
      ...current,
      {
        id: toastId,
        message,
        error: isError,
      },
    ]);
    setTimeout(
      () =>
        setToasts((current) => current.filter((item) => item.id !== toastId)),
      6e3,
    );
  }, []);
  const refresh = useCallback(async () => {
    const requestId = ++loadId.current;
    setLoading(true);
    setError("");
    try {
      const session = await loadSession();
      if (requestId !== loadId.current) {
        return;
      }
      setActiveUser(session || GUEST_USER);
      setUser(session || GUEST_USER);
      setAuthenticated(!!session);
      if (!config.apiBase) {
        setExpenses([]);
        setCategories([]);
        return;
      }
      const [loadedExpenses, loadedCategories] = await Promise.all([
        api.getExpenses(),
        api.getCategories(),
      ]);
      if (requestId === loadId.current) {
        setExpenses(loadedExpenses);
        setCategories(loadedCategories);
      }
    } catch (error) {
      if (requestId === loadId.current) {
        setExpenses([]);
        setCategories([]);
        setError(
          error instanceof Error ? error.message : "Unable to load expenses.",
        );
      }
    } finally {
      if (requestId === loadId.current) {
        setLoading(false);
      }
    }
  }, []);
  const logout = async () => {
    await endSession();
    loadId.current++;
    setActiveUser(GUEST_USER);
    setUser(GUEST_USER);
    setAuthenticated(false);
    setExpenses([]);
    setCategories([]);
    setLoading(false);
    setError(
      "You have signed out. Sign in through your organization to continue.",
    );
  };
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);
  const upsert = (expense) =>
    setExpenses((current) =>
      current.some((item) => item.id === expense.id)
        ? current.map((item) => (item.id === expense.id ? expense : item))
        : [expense, ...current],
    );
  async function run(task, successMessage) {
    setPendingRequests((current) => current + 1);
    try {
      const result = await task();
      if (successMessage) {
        notify(successMessage);
      }
      return result;
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "Something went wrong. Please retry.",
        true,
      );
      return;
    } finally {
      setPendingRequests((current) => current - 1);
    }
  }
  return (
    <WorkspaceContext.Provider
      value={{
        user,
        authenticated,
        logout,
        expenses,
        categories,
        loading,
        error,
        refresh,
        upsert,
        upsertCategory: (category) =>
          setCategories((current) =>
            current.some((item) => item.id === category.id)
              ? current.map((item) =>
                  item.id === category.id ? category : item,
                )
              : [...current, category],
          ),
        notify,
        run,
        busy: pendingRequests > 0,
        online,
        toasts,
      }}
    >
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.error ? "alert" : "status"}
            className={`toast ${toast.error ? "error" : ""}`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </WorkspaceContext.Provider>
  );
}
