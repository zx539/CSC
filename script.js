// 在 script.js 开头引入必要的模块
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ipcRenderer } = require('electron');

// 岗位类型映射表：将岗位标识符映射为中文名称
/**
 * @type {Object}
 * @property {string} ai-engineer - 人工智能工程师岗位
 * @property {string} big-data-analyst - 大数据分析师岗位
 * @property {string} iot-specialist - 物联网专家岗位
 * @property {string} product-manager - 产品经理岗位
 */
const scenarioLabels = {
    'ai-engineer': '人工智能工程师',
    'big-data-analyst': '大数据分析师',
    'iot-specialist': '物联网专家',
    'product-manager': '产品经理'
};

// 全局变量定义
let isPaused = false; // 是否处于暂停状态
const ratingLabels = ['知识专业水平', '技能匹配度', '语言表达能力', '逻辑思维能力', '创新能力', '应变抗压能力'];
let currentScores = [8, 7, 9, 6, 5, 7]; // 示例评分数据
let allowAnalysisAccess = false;
let mediaRecorder, recordedChunks = [], startTime = null, timerInterval = null;
let currentScenario = '', currentQuestionIndex = 0;
let scoreInterval, radarChartInstance = null;
let pauseBtn = null; // 对暂停/继续按钮的引用


/**
 * 题库数据结构：根据不同的岗位提供不同的面试问题
 * @type {Object}
 * @property {Array<string>} ai-engineer - 人工智能工程师面试题列表
 * @property {Array<string>} big-data-analyst - 大数据分析师面试题列表
 * @property {Array<string>} iot-specialist - 物联网专家面试题列表
 * @property {Array<string>} product-manager - 产品经理面试题列表
 */
const interviewQuestions = {
    "ai-engineer": [
        "请解释深度学习与传统机器学习的区别",
        "如何处理训练数据中的类别不平衡问题",
        "请描述反向传播算法的工作原理"
    ],
    "big-data-analyst": [
        "请说明Hadoop和Spark的核心区别",
        "如何设计实时数据处理流水线",
        "请解释Lambda架构的优缺点"
    ],
    "iot-specialist": [
        "物联网系统中MQTT协议的优势是什么",
        "如何保障智能设备的数据安全",
        "请说明边缘计算与云计算的协同方式"
    ],
    "product-manager": [
        "如何制定产品的MVP方案",
        "请描述用户画像的构建方法",
        "如何处理产品迭代中的需求变更"
    ]
};

/**
 * 显示指定ID的页面部分，隐藏其他部分
 * @param {string} sectionId - 要显示的页面部分的ID
 */
function showSection(sectionId) {
    if (!allowAnalysisAccess && sectionId === 'analysis-results') {
        alert('请先完成录制再查看分析结果');
        return;
    }
    document.querySelectorAll('.section').forEach(section => {
        section.style.display = 'none';
    });
    document.getElementById(sectionId).style.display = 'block';
}

/**
 * 计时器管理对象：包含计时器相关的状态和方法
 * @type {Object}
 * @property {boolean} isPaused - 当前是否处于暂停状态
 * @property {boolean} isRecording - 当前是否正在录制
 * @property {number|null} startTime - 录制开始时间戳
 * @property {number} elapsedTime - 已经过去的时间（秒）
 * @method updateStatus - 更新录制状态的方法
 */
const recordingState = {
    isPaused: false,
    isRecording: false,
    startTime: null,
    elapsedTime: 0, // 已经过去的时间

    // 更新状态的方法
    updateStatus(newStatus) {
        this.isPaused = newStatus === 'paused';
        this.isRecording = newStatus === 'recording';
    }
};

/**
 * 开始计时器
 * @param {number} resumeFrom - 从指定时间点恢复计时（毫秒）
 */
function startTimer(resumeFrom = 0) {
    if (timerInterval) {
        clearInterval(timerInterval);
    }

    // 记录开始时间点
    recordingState.startTime = new Date().getTime() - resumeFrom;
    recordingState.elapsedTime = resumeFrom;

    timerInterval = setInterval(() => {
        if (recordingState.isPaused) return;

        const elapsed = Math.floor((new Date().getTime() - recordingState.startTime) / 1000);
        recordingState.elapsedTime = elapsed;

        const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
        const seconds = (elapsed % 60).toString().padStart(2, '0');

        const timerElement = document.getElementById('recording-timer');
        if (timerElement) {
            timerElement.textContent = `${minutes}:${seconds}`;
        }
    }, 1000);
}

/**
 * 停止计时器
 */
function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

/**
 * 初始化摄像头并设置媒体录制
 * @async
 * @returns {Promise<void>}
 * @throws {Error} 如果无法访问摄像头会抛出错误
 */
async function initializeCamera() {
    try {
        const video = document.getElementById('video-preview');
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        video.srcObject = stream;
        
        // 检查是否支持 video/mp4 格式
        const options = MediaRecorder.isTypeSupported('video/mp4') 
            ? { mimeType: 'video/mp4' } 
            : { mimeType: 'video/webm' };
            
        mediaRecorder = new MediaRecorder(stream, options);
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) recordedChunks.push(event.data);
        };
        mediaRecorder.onstop = () => {
            const blob = new Blob(recordedChunks, { type: options.mimeType });
            URL.createObjectURL(blob); // 可用于回放或上传
            recordedChunks = [];
        };
    } catch (err) {
        console.error('无法访问摄像头:', err);
        alert('无法启动摄像头，请检查设备权限');
    }
}


/**
 * 开始录制视频
 */
function startRecording() {
    if (mediaRecorder && mediaRecorder.state === 'inactive') {
        recordedChunks = [];
        mediaRecorder.start();
        startTimer();
        startRealTimeScoring();
        document.querySelectorAll('.recording').forEach(btn => btn.disabled = false);
    }
}

/**
 * 暂停录制

/**
 * 停止录制
 * @description 停止当前录制过程，清理资源并展示分析结果
 */
function stopRecording() {
    if (!mediaRecorder || !['recording', 'paused'].includes(mediaRecorder.state)) {
        alert('请先录制视频');
        return;
    }
    mediaRecorder.stop();
    stopTimer();
      // 重置状态
    recordingState.isPaused = false;
    recordingState.isRecording = false;
    recordingState.startTime = null;
    recordingState.elapsedTime = 0;
    if (scoreInterval) {
        clearInterval(scoreInterval);
        scoreInterval = null;
    }
    const video = document.getElementById('video-preview');
    const stream = video.srcObject;
    if (stream) {
        const tracks = stream.getTracks();
        tracks.forEach(track => track.stop());
    }
    video.srcObject = null;
    if (radarChartInstance) {
        updateRadarChart();
    } else {
        initRadarChart();
    }
    allowAnalysisAccess = true;
    showSection('analysis-results');

    // 结束录制时显示 '选择面试场景' 部分
    const jobSelectionCard = document.getElementById('job-selection-card');
    if (jobSelectionCard) {
        jobSelectionCard.style.display = '';
    }

    // 创建 Blob 并保存为 MP4 文件
    if (recordedChunks.length === 0) {
        console.warn('没有录制到任何数据');
        alert('录制数据为空，无法保存视频');
        return;
    }

    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
    
    // 使用 NW.js 应用根目录下的 video 文件夹作为保存路径
    const saveDir = path.resolve(__dirname, '..', 'video');
    const filename = `interview_recording_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.mp4`;
    const filePath = path.join(saveDir, filename);

    // 添加详细日志输出
    console.log(`尝试保存至: ${filePath}`);
    console.log(`当前工作目录: ${__dirname}`);
    console.log(`目标文件夹是否存在: ${fs.existsSync(saveDir)}`);

    // 强制递归创建目录并捕获错误
    try {
        if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir, { recursive: true });
            console.log(`目录已创建: ${saveDir}`);
        }
    } catch (err) {
        console.error('创建目录失败:', err);
        alert(`无法创建保存目录:\n${err.message}`);
        return;
    }

    // 将 Blob 转换为 ArrayBuffer
    const reader = new FileReader();
    reader.onload = function() {
        const buffer = Buffer.from(reader.result);
        fs.writeFile(filePath, buffer, err => {
            if (err) {
                console.error('写入文件失败:', err);
                alert(`保存视频失败:\n${err.message}`);
                return;
            }
            console.log(`✅ 视频已成功保存至: ${filePath}`);
            alert(`视频已保存至:\n${filePath}`);
        });
    };
    reader.readAsArrayBuffer(blob);

    recordedChunks = [];
}

/**
 * 校验简历文件
 * @param {HTMLInputElement} input - 文件输入元素
 * @returns {boolean} - 文件是否有效
 */
function validateResumeFile(input) {
    const file = input.files[0];
    const errorDiv = document.getElementById('resume-error');
    const allowedTypes = ['application/pdf', 'text/pdf'];
    const maxSize = 10 * 1024 * 1024;
    errorDiv.style.display = 'none';
    input.setCustomValidity('');
    if (!file) return true;
    if (!allowedTypes.includes(file.type)) {
        errorDiv.textContent = '仅支持 PDF 格式的简历文件';
        errorDiv.style.display = 'block';
        input.setCustomValidity('仅支持 PDF 文件');
        return false;
    }
    if (file.size > maxSize) {
        errorDiv.textContent = '文件大小不能超过 10MB';
        errorDiv.style.display = 'block';
        input.setCustomValidity('文件过大');
        return false;
    }
    return true;
}

/**
 * 生成面试题目
 * @param {string} scenario - 岗位类型
 * @returns {boolean} - 是否成功生成题目
 */
function generateInterviewQuestion(scenario) {
    if (!interviewQuestions.hasOwnProperty(scenario)) {
        console.error('无效的岗位类型:', scenario);
        return false;
    }
    currentScenario = scenario;
    currentQuestionIndex = 0;
    const questionElement = document.getElementById('current-question');
    const questionNumberElement = document.getElementById('question-number');
    if (questionElement && questionNumberElement) {
        questionElement.textContent = interviewQuestions[scenario][0];
        questionNumberElement.textContent = 1;
        return true;
    }
    return false;
}

/**
 * 切换面试题目
 * @param {number} direction - 切换方向（+1 下一题，-1 上一题）
 */
function changeQuestion(direction) {
    const questions = interviewQuestions[currentScenario];
    if (!questions) return;
    currentQuestionIndex += direction;
    if (currentQuestionIndex < 0) currentQuestionIndex = 0;
    if (currentQuestionIndex >= questions.length) currentQuestionIndex = questions.length - 1;
    document.getElementById('current-question').textContent = questions[currentQuestionIndex];
    document.getElementById('question-number').textContent = currentQuestionIndex + 1;
}

/**
 * 切到上一题
 */
function prevQuestion() { changeQuestion(-1); }

/**
 * 切到下一题
 */
function nextQuestion() { changeQuestion(1); }

/**
 * 生成简历
 * @description 根据面试表现生成一个简单的文本格式简历建议
 */
function generateResume() {
    const scenarioLabel = scenarioLabels[currentScenario] || currentScenario;
    const feedbackText = `
智鉴 AI 面试助手 - 简历生成
姓名：[请填写姓名]
应聘岗位：${scenarioLabel}
技能匹配度：★★★☆☆
语言表达能力：★★★★☆
创新能力：★★★☆☆
其他特长：
- 良好的沟通技巧
- 快速学习能力强
- 团队协作经验丰富

根据面试表现，我们建议您加强基础知识理解和表达逻辑性。
`;
    const blob = new Blob([feedbackText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${scenarioLabel}_简历.txt`;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * 开始实时打分模拟
 * @description 启动定时器定期更新评分数据
 */
function startRealTimeScoring() {
    scoreInterval = setInterval(() => {
        for (let i = 0; i < currentScores.length; i++) {
            const change = Math.floor(Math.random() * 3) - 1;
            currentScores[i] = Math.min(10, Math.max(0, currentScores[i] + change));
        }
    }, 5000);
}

/**
 * 计算平均分数
 * @param {Array<number>} scoresArray - 分数数组
 * @returns {Array<number>} - 平均分数数组
 */
function calculateAverageScores(scoresArray) {
    const avg = scoresArray.reduce((acc, val) => acc + val, 0) / scoresArray.length;
    return new Array(scoresArray.length).fill(avg);
}

/**
 * 更新雷达图
 * @description 使用当前评分数据更新图表
 */
function updateRadarChart() {
    if (!radarChartInstance) return;
    const averageScores = calculateAverageScores(currentScores);
    radarChartInstance.data.datasets[0].data = averageScores;
    radarChartInstance.update();
    document.getElementById('feedback-text').innerText = `
知识专业水平: ${averageScores[0]}/10
技能匹配度: ${averageScores[1]}/10
语言表达能力: ${averageScores[2]}/10
逻辑思维能力: ${averageScores[3]}/10
创新能力: ${averageScores[4]}/10
应变抗压能力: ${averageScores[5]}/10
`;
}

/**
 * 初始化雷达图
 * @description 创建新的雷达图实例
 */
function initRadarChart() {
    const ctx = document.getElementById('radar-chart').getContext('2d');
    radarChartInstance = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: ratingLabels,
            datasets: [{
                label: '平均评分',
                backgroundColor: 'rgba(46, 204, 113, 0.2)',
                borderColor: 'rgba(46, 204, 113, 1)',
                pointBackgroundColor: 'rgba(46, 204, 113, 1)',
                data: calculateAverageScores(currentScores)
            }]
        },
        options: {
            scale: {
                ticks: {
                    beginAtZero: true,
                    max: 10
                }
            }
        }
    });
}

/**
 * 面试开始主流程
 * @description 初始化面试环境，准备录制并展示相关界面
 */
function startInterview() {
    const scenarioSelect = document.getElementById('job-scenario');
    const resumeInput = document.getElementById('resume-upload');
    const scenario = scenarioSelect.value;
    if (!scenario) { alert('请选择一个面试场景'); return; }
    if (!['ai-engineer', 'big-data-analyst', 'iot-specialist', 'product-manager'].includes(scenario)) {
        alert('请选择有效的面试岗位');
        return;
    }
    if (!resumeInput.files.length) { alert('请上传您的简历文件'); return; }
    if (!validateResumeFile(resumeInput)) return;
    if (!generateInterviewQuestion(scenario)) {
        alert('无法加载题目，请检查选择的岗位');
        return;
    }
    showSection('mock-interview');
    document.getElementById('video-recording').style.display = 'block';
    initializeCamera();

    // 开始录制时隐藏 '选择面试场景' 部分
    const jobSelectionCard = document.getElementById('job-selection-card');
    if (jobSelectionCard) {
        jobSelectionCard.style.display = 'none';
    }

    if (radarChartInstance) {
        radarChartInstance.data.datasets[0].data = calculateAverageScores(currentScores);
        radarChartInstance.update();
    } else {
        initRadarChart();
    }
    document.getElementById('improvement-tips').innerHTML = `
<strong>改进建议：</strong><br/>
- 加强基础知识的理解与应用<br/>
- 提高表达清晰度和逻辑性<br/>
- 多进行压力测试训练以增强应变能力
`;

    console.log('初始化录制按钮状态');
    // 初始化录制状态
    recordingState.isPaused = false;
    recordingState.isRecording = false;
    recordingState.startTime = null;
    recordingState.elapsedTime = 0;

    // 重置按钮状态
    updatePauseResumeButton(false);
    // 强制重排以确保状态更新
    void document.getElementById('resume-btn').offsetWidth;

    // 添加额外的日志输出
    console.log('pause-btn 显示状态:', window.getComputedStyle(document.getElementById('pause-btn')).display);
    console.log('resume-btn 显示状态:', window.getComputedStyle(document.getElementById('resume-btn')).display);

    // 重置其他相关界面元素状态
    document.querySelectorAll('.recording').forEach(btn => btn.disabled = false);
    document.querySelectorAll('.paused').forEach(btn => btn.disabled = true);
}

/**
 * 获取AI回复
 * @param {string} userMessage - 用户消息
 * @returns {string} - AI回复内容
 */
function getAIResponse(userMessage) {
    const responses = {
        "你好": "您好！我是智鉴 AI 面试助手，有什么可以帮助您的？",
        "面试技巧": "面试时注意表达清晰、逻辑严谨，回答要结合实际经验。",
        "如何准备简历": "建议突出项目经验和技能匹配度，保持简洁明了。",
        "自我介绍": "请从学习经历、项目经验、职业规划等方面简要介绍自己。",
        "default": "这是个好问题，我会继续学习并提供更完善的建议。"
    };
    return responses[userMessage.toLowerCase()] || responses.default;
}

/**
 * 发送消息
 * @description 处理用户发送的消息并获取AI回复
 */
function sendMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    if (!message) return;
    addMessage(message, 'user');
    input.value = '';
    setTimeout(() => {
        const response = getAIResponse(message);
        addMessage(response, 'ai');
    }, 800);
}

/**
 * 添加消息到聊天容器
 * @param {string} text - 消息文本
 * @param {string} sender - 发送者类型（'user' 或 'ai'）
 */
function addMessage(text, sender) {
    const container = document.getElementById('chat-container');
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message', sender === 'user' ? 'user-message' : 'ai-message');
    msgDiv.textContent = text;
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
}