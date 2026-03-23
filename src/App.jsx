import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { Utensils, MapPin, Tag, Plus, Loader2, Link2, Image as ImageIcon, Trash2, LogOut, FileText, Navigation, BookOpen } from 'lucide-react';

// --- 環境變數與 Firebase 初始化 ---
// 這裡的邏輯可以自動判斷是在 Canvas 測試環境，還是您自己的 StackBlitz/Vercel 環境
const isCanvasEnv = typeof __firebase_config !== 'undefined';

// 安全地獲取 Vite 環境變數
const getEnv = (key) => {
  try { return import.meta.env[key]; } catch (e) { return undefined; }
};

const firebaseConfig = isCanvasEnv 
  ? JSON.parse(__firebase_config) 
  : {
      apiKey: "AIzaSyAFEiJkrCYvEuaInuOyIXGkHfKf2NU8bvs",
      authDomain: "food-app-acb66.firebaseapp.com",
      projectId: "food-app-acb66",
      storageBucket: "food-app-acb66.firebasestorage.app",
      messagingSenderId: "369341313853",
      appId: "1:369341313853:web:180f7314563e1894588b54"
    };

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Gemini API Key (Canvas 由系統注入，自己的環境由 .env 讀取)
const apiKey = isCanvasEnv ? "" : (getEnv('VITE_GEMINI_API_KEY') || ""); 

// Firestore 資料集路徑產生器
// Canvas 環境有特殊路徑限制，您自己的環境則可以簡化為 'shared_food_list'
const getCollectionRef = () => {
  if (isCanvasEnv) {
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
    return collection(db, 'artifacts', appId, 'public', 'data', 'shared_food');
  } else {
    return collection(db, 'shared_food_list'); // 您自己 Firebase 裡的集合名稱
  }
};

export default function App() {
  const [user, setUser] = useState(null);
  
  const [restaurants, setRestaurants] = useState([]);
  const [inputText, setInputText] = useState('');
  const [selectedImage, setSelectedImage] = useState(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState('');
  
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  
  // Filters
  const [filterLocation, setFilterLocation] = useState('All');
  const [filterType, setFilterType] = useState('All');

  const fileInputRef = useRef(null);



  // --- Auth Effect ---
  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          // Canvas 專屬的自訂驗證
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          // 您自己 Firebase 專案使用的匿名登入
          await signInAnonymously(auth);
        }
      } catch (err) {
        console.error("Auth Error:", err);
      }
    };
    initAuth();

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  // --- Firestore Data Fetching ---
  useEffect(() => {
    if (!user) return;

    const roomCollectionRef = getCollectionRef();
    
    // 讀取資料並保持同步
    const unsubscribe = onSnapshot(roomCollectionRef, (snapshot) => {
      const data = [];
      snapshot.forEach((doc) => {
        data.push({ id: doc.id, ...doc.data() });
      });
      // 依建立時間排序 (最新的在前面)
      data.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
      setRestaurants(data);
    }, (error) => {
      console.error("Firestore error:", error);
      setErrorMsg("資料同步失敗，請檢查資料庫權限或重整頁面。");
    });

    return () => unsubscribe();
  }, [user]);

  // --- Image Handling ---
  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    if (file.size > 5 * 1024 * 1024) {
      setErrorMsg("圖片太大了，請上傳小於 5MB 的圖片。");
      return;
    }

    setSelectedImage(file);
    const reader = new FileReader();
    reader.onloadend = () => {
      setImagePreviewUrl(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const clearInput = () => {
    setInputText('');
    setSelectedImage(null);
    setImagePreviewUrl('');
    setErrorMsg('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // --- Gemini AI Analysis ---
  const analyzeAndAdd = async () => {
    if (!inputText.trim() && !selectedImage) {
      setErrorMsg("請輸入文字、網址或上傳圖片！");
      return;
    }
    
    if (!apiKey && !isCanvasEnv) {
      setErrorMsg("未設定 Gemini API Key！請檢查環境變數 VITE_GEMINI_API_KEY。");
      return;
    }

    setIsAnalyzing(true);
    setErrorMsg('');

    try {
      let promptParts = [
        {
          text: `你是一個強大的美食資料整理助手。使用者會提供一段文字、網址或圖片。請從中分析並提取出餐廳的關鍵資訊。
          【重要任務】：如果使用者提供的資訊（例如只有圖片或店名）沒有明確提及詳細地址，請你「主動運用知識與搜尋能力」，自動幫忙找出這家店的「縣市行政區」、「完整地址」以及「相關食記/介紹網址」。
          請務必只回傳一個乾淨的 JSON 格式字串，不要包含任何 markdown 標記（如 \`\`\`json），格式如下：
          {
            "name": "餐廳或店鋪名稱",
            "location": "縣市與行政區 (例如：嘉義縣太保市、台北市大安區。請務必自動搜尋推斷並補齊)",
            "fullAddress": "完整地址 (例如：嘉義縣太保市祥和一路東段XX號。請務必盡力搜尋找出完整地址並補齊)",
            "type": "食物種類 (如：火鍋、咖啡廳、早午餐、日式料理)",
            "notes": "這家店的特色或推薦餐點 (限30字內)",
            "blogUrl": "這家店的相關食記、部落格介紹或官方網頁網址 (請主動搜尋提供，若無請留白)"
          }`
        }
      ];

      if (inputText.trim()) {
        promptParts.push({ text: `使用者提供的文字/網址內容：\n${inputText}` });
      }

      if (selectedImage && imagePreviewUrl) {
        // 取出 Base64 圖片資料
        const base64Data = imagePreviewUrl.split(',')[1];
        promptParts.push({
          inlineData: {
            mimeType: selectedImage.type,
            data: base64Data
          }
        });
      }

      const payload = {
        contents: [{ parts: promptParts }],
        generationConfig: {
          temperature: 0.1, 
        },
        tools: [{ "google_search": {} }] // 💡 這裡賦予了 AI 即時連網搜尋 Google 的能力
      };

      // 將外部環境的模型也更新為 gemini-2.5-flash
      const endpoint = isCanvasEnv 
        ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`
        : `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error("Gemini API Error Details:", errorData);
        const detailMsg = errorData?.error?.message ? ` (${errorData.error.message})` : "";
        throw new Error(`AI 分析失敗，請檢查金鑰是否正確且有效。${detailMsg}`);
      }
      
      const result = await response.json();
      let aiText = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      // 清理 Markdown 標記確保是純 JSON
      aiText = aiText.replace(/```json/gi, '').replace(/```/g, '').trim();
      
      let parsedData;
      try {
        parsedData = JSON.parse(aiText);
      } catch (e) {
        console.error("JSON Parse Error:", aiText);
        throw new Error("AI 無法正確解析資訊，請嘗試提供更清晰的內容。");
      }

      if (!parsedData.name || parsedData.name === "") {
        throw new Error("找不到餐廳名稱，請提供更詳細的資訊。");
      }

      // 將結果存入 Firestore (新增 fullAddress 與 blogUrl 欄位)
      const roomCollectionRef = getCollectionRef();
      await addDoc(roomCollectionRef, {
        name: parsedData.name,
        location: parsedData.location || '未分類',
        fullAddress: parsedData.fullAddress || '', 
        type: parsedData.type || '未分類',
        notes: parsedData.notes || '',
        blogUrl: parsedData.blogUrl || '', // 儲存食記網址
        sourceText: inputText.substring(0, 150), 
        hasImage: !!selectedImage, 
        createdAt: serverTimestamp(),
        addedBy: user.uid
      });

      clearInput();

    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || "發生錯誤，請稍後再試。");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const deleteRestaurant = async (id) => {
    try {
      if (isCanvasEnv) {
        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'shared_food', id));
      } else {
        await deleteDoc(doc(db, 'shared_food_list', id));
      }
    } catch (err) {
      console.error("Delete error:", err);
    }
  };

  // --- Derived Data for Filters ---
  const locations = ['All', ...new Set(restaurants.map(r => r.location).filter(Boolean))];
  const types = ['All', ...new Set(restaurants.map(r => r.type).filter(Boolean))];

  const filteredRestaurants = restaurants.filter(r => {
    const matchLoc = filterLocation === 'All' || r.location === filterLocation;
    const matchType = filterType === 'All' || r.type === filterType;
    return matchLoc && matchType;
  });

  // --- UI Renders ---
  return (
    <div className="min-h-screen bg-slate-900 text-gray-100 font-sans pb-10">
      {/* Header */}
      <header className="bg-slate-800 shadow-md border-b border-slate-700 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-2 text-orange-500">
            <Utensils size={24} />
            {/* 更新主要標題 */}
            <h1 className="text-xl font-bold text-white">美食丸家筆記</h1>
            {/* 新增環境標籤，協助確認雙方是否在同一個資料庫 */}
            <span className="hidden sm:inline-block text-xs px-2 py-0.5 rounded-full font-medium ml-2 border border-orange-700/50 bg-orange-900/30 text-orange-400">
              {isCanvasEnv ? '🛠 開發測試區' : '✅ 正式連線區'}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 mt-6 space-y-8">
        
        {/* Input Section */}
        <section className="bg-slate-800 rounded-2xl shadow-lg p-5 sm:p-6 border border-slate-700 relative overflow-hidden">
          {/* 裝飾性漸層頂部線條 */}
          <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-orange-500 to-amber-500"></div>
          
          <h2 className="text-lg font-bold text-white mb-4 mt-1 flex items-center gap-2">
            <Plus size={20} className="text-orange-500" />
            新增美食情報
          </h2>
          <p className="text-sm text-gray-400 mb-4">貼上朋友傳的網址、對話文字，或上傳名片/IG截圖，AI 會自動幫你分類！</p>
          
          <div className="space-y-4">
            <textarea
              className="w-full p-3 border border-slate-600 rounded-xl focus:ring-2 focus:ring-orange-500/50 outline-none resize-none bg-slate-900/50 text-white placeholder-gray-500 transition"
              rows="3"
              placeholder="貼上網址或文字描述 (例如：這家太保市的隱藏版甜點店超好吃！網址是...)"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
            />
            
            <div className="flex flex-wrap items-center gap-3">
              <input 
                type="file" 
                accept="image/*" 
                className="hidden" 
                ref={fileInputRef}
                onChange={handleImageChange}
              />
              <button 
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-4 py-2 bg-slate-700 text-gray-300 rounded-lg hover:bg-slate-600 transition text-sm font-medium border border-slate-600"
              >
                <ImageIcon size={18} className="text-gray-400" />
                上傳圖片協助分析
              </button>
              
              {imagePreviewUrl && (
                <div className="relative inline-block shadow-sm">
                  <img src={imagePreviewUrl} alt="Preview" className="h-10 w-10 object-cover rounded-lg border border-slate-600" />
                  <button 
                    onClick={() => { setSelectedImage(null); setImagePreviewUrl(''); }}
                    className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5 hover:bg-red-600 shadow-sm"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )}
            </div>

            {errorMsg && <p className="text-red-400 text-sm font-medium bg-red-900/20 p-3 rounded-lg border border-red-800">{errorMsg}</p>}

            <button 
              onClick={analyzeAndAdd}
              disabled={isAnalyzing}
              className="w-full sm:w-auto flex items-center justify-center gap-2 bg-gradient-to-r from-orange-600 to-orange-500 text-white px-6 py-3 rounded-xl font-bold hover:from-orange-500 hover:to-orange-400 transition shadow-sm disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {isAnalyzing ? <Loader2 className="animate-spin" size={20} /> : <FileText size={20} />}
              {isAnalyzing ? 'AI 正在大腦運算中...' : '自動分析並存入清單'}
            </button>
          </div>
        </section>

        {/* Filters Section */}
        <section className="flex flex-col sm:flex-row gap-4 items-center bg-slate-800/80 p-4 rounded-xl border border-slate-700">
          <div className="w-full sm:w-1/2 flex items-center gap-2">
            <MapPin size={18} className="text-orange-400" />
            <select 
              value={filterLocation} 
              onChange={(e) => setFilterLocation(e.target.value)}
              className="w-full p-2.5 bg-slate-700 border border-slate-600 text-white rounded-lg outline-none focus:ring-2 focus:ring-orange-500/50 transition shadow-sm"
            >
              {locations.map(loc => <option key={loc} value={loc}>{loc === 'All' ? '所有地點' : loc}</option>)}
            </select>
          </div>
          <div className="w-full sm:w-1/2 flex items-center gap-2">
            <Tag size={18} className="text-orange-400" />
            <select 
              value={filterType} 
              onChange={(e) => setFilterType(e.target.value)}
              className="w-full p-2.5 bg-slate-700 border border-slate-600 text-white rounded-lg outline-none focus:ring-2 focus:ring-orange-500/50 transition shadow-sm"
            >
              {types.map(type => <option key={type} value={type}>{type === 'All' ? '所有類型' : type}</option>)}
            </select>
          </div>
        </section>

        {/* List Section */}
        <section>
          {restaurants.length === 0 ? (
            <div className="text-center py-16 text-gray-400 bg-slate-800 rounded-2xl border border-slate-700 border-dashed">
              <Utensils size={48} className="mx-auto mb-4 text-gray-600" />
              <p className="font-medium text-gray-400">清單還是空的喔！</p>
              <p className="text-sm mt-1 text-gray-500">趕快貼上資訊，讓 AI 幫你們整理美食清單吧！</p>
            </div>
          ) : (
            /* 將 gap-4 加大為 gap-6，讓卡片之間有更多呼吸空間 */
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {filteredRestaurants.map(rest => (
                <div key={rest.id} className="bg-slate-800 p-6 rounded-2xl shadow-lg border border-slate-700 hover:border-slate-600 hover:shadow-xl hover:-translate-y-1 transition-all duration-300 relative group flex flex-col overflow-hidden">
                  
                  {/* 卡片頂部裝飾線條 */}
                  <div className="absolute top-0 left-0 right-0 h-1 bg-orange-500 opacity-80"></div>

                  <button 
                    onClick={() => { if(window.confirm('確定要刪除這筆紀錄嗎？')) deleteRestaurant(rest.id); }}
                    className="absolute top-4 right-4 text-gray-500 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 bg-slate-800 rounded-full p-1 hover:bg-red-900/30"
                    title="刪除這筆紀錄"
                  >
                    <Trash2 size={18} />
                  </button>
                  
                  {/* 將餐廳名稱字體放大並加黑 */}
                  <h3 className="text-xl font-black text-white pr-8 mt-1 tracking-wide">{rest.name}</h3>
                  
                  <div className="flex flex-wrap gap-2 mt-3 mb-4">
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-orange-300 bg-orange-900/40 px-2.5 py-1 rounded-md shadow-sm">
                      <MapPin size={12} /> {rest.location}
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-300 bg-blue-900/40 px-2.5 py-1 rounded-md shadow-sm">
                      <Tag size={12} /> {rest.type}
                    </span>
                  </div>

                  {/* 顯示詳細地址 */}
                  {rest.fullAddress && (
                    <div className="text-sm text-gray-300 mb-3 flex items-start gap-1.5 font-medium">
                      <MapPin size={16} className="shrink-0 mt-0.5 text-gray-500" />
                      <span>{rest.fullAddress}</span>
                    </div>
                  )}
                  
                  {/* 優化筆記區塊為引言樣式，增加吸睛度 */}
                  {rest.notes && (
                    <div className="text-sm text-gray-200 bg-orange-900/20 border-l-4 border-orange-500/50 p-3 rounded-r-lg mb-4 leading-relaxed font-medium">
                      <span className="mr-1">💡</span> {rest.notes}
                    </div>
                  )}
                  
                  {/* 底部按鈕區塊 */}
                  <div className="mt-auto pt-4 flex flex-col sm:flex-row sm:items-center justify-between border-t border-slate-700 gap-4">
                    {rest.sourceText ? (
                      <div className="text-xs text-gray-500 flex items-start gap-1 flex-1 pr-2">
                        <Link2 size={14} className="shrink-0 mt-0.5 text-gray-600" />
                        <span className="line-clamp-2 break-all italic">{rest.sourceText}</span>
                      </div>
                    ) : <div className="hidden sm:block flex-1" />}

                    {/* 操作按鈕群，增加按鈕的點擊感與對比 */}
                    <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
                      {rest.blogUrl && (
                        <a
                          href={rest.blogUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-sm font-bold text-orange-400 bg-orange-900/30 px-3.5 py-2 rounded-xl hover:bg-orange-900/50 transition-colors shadow-sm"
                        >
                          <BookOpen size={16} /> 查看食記
                        </a>
                      )}
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(rest.name + ' ' + (rest.fullAddress || rest.location))}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm font-bold text-blue-400 bg-blue-900/30 px-3.5 py-2 rounded-xl hover:bg-blue-900/50 transition-colors shadow-sm"
                      >
                        <Navigation size={16} /> 在地圖開啟
                      </a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {filteredRestaurants.length === 0 && restaurants.length > 0 && (
            <div className="text-center py-12 text-gray-500 bg-slate-800 rounded-2xl border border-slate-700">
              找不到符合條件的餐廳。
            </div>
          )}
        </section>

      </main>
    </div>
  );
}