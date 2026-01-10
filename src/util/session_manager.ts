interface FileUploadSession {
    fileName: string;
    fileContent: string;
    stage: 'uploaded' | 'create_task' | 'modify_params';
    defaultParams: {
        name: string;
        command: string;
        schedule: string;
    };
    timeoutId?: NodeJS.Timeout;
}

const sessions = new Map<number, FileUploadSession>();

function extractCronFromContent(content: string): string | null {
    const cronRegex = /([0-9*/,-]{1,} ){4,5}([0-9*/,-]){1,}/;
    const match = content.match(cronRegex);
    
    if (match) {
        const cronExpression = match[0].trim();
        const parts = cronExpression.split(/\s+/);
        
        if (parts.length >= 5) {
            let finalCronExpression = cronExpression;
            
            if (parts.length === 6) {
                finalCronExpression = parts.slice(1).join(' ');
            }
            
            return finalCronExpression;
        }
    }
    return null;
}

function createSession(userId: number, fileName: string, fileContent: string): FileUploadSession {
    const cronFromContent = extractCronFromContent(fileContent);
    const defaultSchedule = cronFromContent || '0 0 * * *';
    const session: FileUploadSession = {
        fileName,
        fileContent,
        stage: 'uploaded',
        defaultParams: {
            name: fileName.split('.')[0],
            command: `task ${fileName}`,
            schedule: defaultSchedule
        }
    };
    sessions.set(userId, session);
    return session;
}

function getSession(userId: number): FileUploadSession | undefined {
    return sessions.get(userId);
}

function updateSession(userId: number, updates: Partial<FileUploadSession>): void {
    const session = sessions.get(userId);
    if (session) {
        Object.assign(session, updates);
    }
}

function deleteSession(userId: number): void {
    const session = sessions.get(userId);
    if (session && session.timeoutId) {
        clearTimeout(session.timeoutId);
    }
    sessions.delete(userId);
}

function setSessionTimeout(userId: number, timeoutMs: number, callback: () => void): void {
    const session = sessions.get(userId);
    if (!session) {
        return;
    }

    if (session.timeoutId) {
        clearTimeout(session.timeoutId);
    }

    session.timeoutId = setTimeout(() => {
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
