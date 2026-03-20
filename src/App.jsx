import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { Utensils, MapPin, Tag, Plus, Loader2, Link2, Image as ImageIcon, Trash2, LogOut, FileText } from 'lucide-react';

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
          text: `你是一個美食資料整理助手。使用者會提供一段文字、網址或圖片。請從中分析並提取出餐廳的關鍵資訊。
          如果資訊不完整，請根據常理推斷或留白。
          請務必只回傳一個乾淨的 JSON 格式字串，不要包含任何 markdown 標記（如 \`\`\`json），格式如下：
          {
            "name": "餐廳或店鋪名稱",
            "location": "縣市與行政區 (如：台北市信義區、嘉義縣太保市，盡量精簡)",
            "type": "食物種類 (如：火鍋、咖啡廳、早午餐、日式料理)",
            "notes": "這家店的特色或推薦餐點 (限30字內)"
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
        }
      };

      // 將外部環境的模型也更新為 gemini-2.5-flash，解決原本 1.5-flash 找不到的問題
      const endpoint = isCanvasEnv 
        ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`
        : `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        // 解析並印出實際的 API 錯誤原因
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

      // 將結果存入 Firestore
      const roomCollectionRef = getCollectionRef();
      await addDoc(roomCollectionRef, {
        name: parsedData.name,
        location: parsedData.location || '未分類',
        type: parsedData.type || '未分類',
        notes: parsedData.notes || '',
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
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans pb-10">
      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-2 text-orange-500">
            <Utensils size={24} />
            <h1 className="text-xl font-bold text-gray-900">夫妻美食筆記</h1>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 mt-6 space-y-8">
        
        {/* Input Section */}
        <section className="bg-white rounded-2xl shadow-sm p-5 sm:p-6 border border-gray-100">
          <h2 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
            <Plus size={20} className="text-orange-500" />
            新增美食情報
          </h2>
          <p className="text-sm text-gray-600 mb-4">貼上朋友傳的網址、對話文字，或上傳名片/IG截圖，AI 會自動幫你分類！</p>
          
          <div className="space-y-4">
            <textarea
              className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-200 outline-none resize-none bg-gray-50"
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
                className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition text-sm font-medium"
              >
                <ImageIcon size={18} />
                上傳圖片協助分析
              </button>
              
              {imagePreviewUrl && (
                <div className="relative inline-block">
                  <img src={imagePreviewUrl} alt="Preview" className="h-10 w-10 object-cover rounded-lg border border-gray-300" />
                  <button 
                    onClick={() => { setSelectedImage(null); setImagePreviewUrl(''); }}
                    className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5 hover:bg-red-600"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )}
            </div>

            {errorMsg && <p className="text-red-500 text-sm font-medium bg-red-50 p-3 rounded-lg border border-red-100">{errorMsg}</p>}

            <button 
              onClick={analyzeAndAdd}
              disabled={isAnalyzing}
              className="w-full sm:w-auto flex items-center justify-center gap-2 bg-orange-500 text-white px-6 py-3 rounded-xl font-bold hover:bg-orange-600 transition disabled:opacity-70"
            >
              {isAnalyzing ? <Loader2 className="animate-spin" size={20} /> : <FileText size={20} />}
              {isAnalyzing ? 'AI 正在大腦運算中...' : '自動分析並存入清單'}
            </button>
          </div>
        </section>

        {/* Filters Section */}
        <section className="flex flex-col sm:flex-row gap-4 items-center bg-orange-50 p-4 rounded-xl">
          <div className="w-full sm:w-1/2 flex items-center gap-2">
            <MapPin size={18} className="text-gray-500" />
            <select 
              value={filterLocation} 
              onChange={(e) => setFilterLocation(e.target.value)}
              className="w-full p-2 bg-white border border-gray-200 rounded-lg outline-none"
            >
              {locations.map(loc => <option key={loc} value={loc}>{loc === 'All' ? '所有地點' : loc}</option>)}
            </select>
          </div>
          <div className="w-full sm:w-1/2 flex items-center gap-2">
            <Tag size={18} className="text-gray-500" />
            <select 
              value={filterType} 
              onChange={(e) => setFilterType(e.target.value)}
              className="w-full p-2 bg-white border border-gray-200 rounded-lg outline-none"
            >
              {types.map(type => <option key={type} value={type}>{type === 'All' ? '所有類型' : type}</option>)}
            </select>
          </div>
        </section>

        {/* List Section */}
        <section>
          {restaurants.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <Utensils size={48} className="mx-auto mb-4 opacity-20" />
              <p>清單還是空的，趕快貼上資訊讓 AI 幫你們整理吧！</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredRestaurants.map(rest => (
                <div key={rest.id} className="bg-white p-5 rounded-xl shadow-sm border border-gray-100 hover:shadow-md transition relative group">
                  <button 
                    onClick={() => { if(window.confirm('確定要刪除這筆紀錄嗎？')) deleteRestaurant(rest.id); }}
                    className="absolute top-4 right-4 text-gray-300 hover:text-red-500 transition opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 size={18} />
                  </button>
                  
                  <h3 className="text-lg font-bold text-gray-800 pr-8">{rest.name}</h3>
                  
                  <div className="flex flex-wrap gap-2 mt-3 mb-3">
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-orange-700 bg-orange-100 px-2.5 py-1 rounded-full">
                      <MapPin size={12} /> {rest.location}
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 bg-blue-100 px-2.5 py-1 rounded-full">
                      <Tag size={12} /> {rest.type}
                    </span>
                  </div>
                  
                  {rest.notes && (
                    <p className="text-sm text-gray-600 bg-gray-50 p-3 rounded-lg mb-3">
                      💡 {rest.notes}
                    </p>
                  )}
                  
                  {rest.sourceText && (
                    <div className="text-xs text-gray-400 mt-2 flex items-start gap-1">
                      <Link2 size={14} className="shrink-0 mt-0.5" />
                      <span className="line-clamp-2 break-all">{rest.sourceText}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {filteredRestaurants.length === 0 && restaurants.length > 0 && (
            <div className="text-center py-8 text-gray-400">
              找不到符合條件的餐廳。
            </div>
          )}
        </section>

      </main>
    </div>
  );
}