interface FileUploadSession {
    fileName: string;
    fileContent: string;
    stage: 'uploaded' | 'create_task' | 'modify_params' | 'confirm_params';
    defaultParams?: {
        name: string;
        command: string;
        schedule: string;
    };
    modifiedParams?: {
        name: string;
        command: string;
        schedule: string;
    };
    timeoutId?: NodeJS.Timeout;
}

const sessions = new Map<number, FileUploadSession>();

function createSession(userId: number, fileName: string, fileContent: string): FileUploadSession {
    const session: FileUploadSession = {
        fileName,
        fileContent,
        stage: 'uploaded',
        defaultParams: {
            name: fileName.split('.')[0],
            command: `task ${fileName}`,
            schedule: '0 0 * * *'
        }
    };
    sessions.set(userId, session);
    console.log(`✅ [session_manager] 创建会话 - 用户ID: ${userId}, 文件名: ${fileName}, 阶段: ${session.stage}`);
    return session;
}

function getSession(userId: number): FileUploadSession | undefined {
    const session = sessions.get(userId);
    if (session) {
        console.log(`✅ [session_manager] 获取会话 - 用户ID: ${userId}, 阶段: ${session.stage}`);
    } else {
        console.log(`❌ [session_manager] 会话不存在 - 用户ID: ${userId}`);
    }
    return session;
}

function updateSession(userId: number, updates: Partial<FileUploadSession>): void {
    const session = sessions.get(userId);
    if (session) {
        const oldStage = session.stage;
        Object.assign(session, updates);
        console.log(`🔄 [session_manager] 更新会话 - 用户ID: ${userId}, 阶段: ${oldStage} -> ${session.stage}`);
    } else {
        console.log(`❌ [session_manager] 更新失败，会话不存在 - 用户ID: ${userId}`);
    }
}

function deleteSession(userId: number): void {
    const session = sessions.get(userId);
    if (session && session.timeoutId) {
        clearTimeout(session.timeoutId);
        console.log(`⏰ [session_manager] 清除超时定时器 - 用户ID: ${userId}`);
    }
    sessions.delete(userId);
    console.log(`🗑️ [session_manager] 删除会话 - 用户ID: ${userId}`);
}

function setSessionTimeout(userId: number, timeoutMs: number, callback: () => void): void {
    const session = sessions.get(userId);
    if (!session) {
        console.log(`❌ [session_manager] 设置超时失败，会话不存在 - 用户ID: ${userId}`);
        return;
    }

    if (session.timeoutId) {
        clearTimeout(session.timeoutId);
        console.log(`⏰ [session_manager] 清除之前的超时定时器 - 用户ID: ${userId}`);
    }

    console.log(`⏱️ [session_manager] 设置超时 - 用户ID: ${userId}, 超时时间: ${timeoutMs}ms`);
    session.timeoutId = setTimeout(() => {
        console.log(`⏰ [session_manager] 会话超时 - 用户ID: ${userId}`);
        deleteSession(userId);
        callback();
    }, timeoutMs);
}

export {
    FileUploadSession,
    createSession,
    getSession,
    updateSession,
    deleteSession,
    setSessionTimeout,
};
