import { useContext } from "react";
import { UploadQueueContext } from "../context/UploadQueueContext";

export const useUploadQueue = () => useContext(UploadQueueContext);
