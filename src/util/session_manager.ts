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

function extractCronFromContent(content: string): string | null {
    console.log(`🔍 [extractCronFromContent] 开始提取 cron 表达式`);
    console.log(`📄 [extractCronFromContent] 内容长度: ${content.length}`);
    console.log(`📄 [extractCronFromContent] 内容预览（前300字符）: ${content.substring(0, 300)}`);
    
    const cronRegex = /([0-9*/,-]{1,} ){4,5}([0-9*/,-]){1,}/;
    const match = content.match(cronRegex);
    
    if (match) {
        const cronExpression = match[0].trim();
        const parts = cronExpression.split(/\s+/);
        console.log(`✅ [extractCronFromContent] 匹配到 cron 表达式: ${cronExpression}, 部分数: ${parts.length}`);
        
        if (parts.length >= 5) {
            let finalCronExpression = cronExpression;
            
            if (parts.length === 6) {
                finalCronExpression = parts.slice(1).join(' ');
                console.log(`✅ [extractCronFromContent] 检测到6部分cron表达式（包含秒），已转换为5部分: ${finalCronExpression}`);
            }
            
            console.log(`✅ [extractCronFromContent] cron 表达式有效，返回: ${finalCronExpression}`);
            return finalCronExpression;
        } else {
            console.log(`❌ [extractCronFromContent] cron 表达式部分数不足，需要至少5个部分`);
        }
    } else {
        console.log(`❌ [extractCronFromContent] 未匹配到 cron 表达式`);
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
    console.log(`✅ [session_manager] 创建会话 - 用户ID: ${userId}, 文件名: ${fileName}, 阶段: ${session.stage}, 定时: ${defaultSchedule}`);
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
